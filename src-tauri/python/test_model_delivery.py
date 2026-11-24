import hashlib
from io import BytesIO
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

from model_delivery import fetch_model


class ModelDeliveryTests(unittest.TestCase):
    def test_valid_download_is_published_after_hash_check(self):
        content = b"verified checkpoint"
        digest = hashlib.sha256(content).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "best_detector.pth"
            with patch("model_delivery.urlopen", return_value=BytesIO(content)):
                fetch_model("https://example.test/model", target, len(content), digest)
            self.assertEqual(target.read_bytes(), content)
            self.assertFalse((Path(directory) / "best_detector.pth.download").exists())

    def test_wrong_hash_never_replaces_existing_model(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "best_detector.pth"
            target.write_bytes(b"trusted")
            with patch("model_delivery.urlopen", side_effect=lambda *_args, **_kwargs: BytesIO(b"corrupt")), patch("model_delivery.time.sleep"):
                with self.assertRaisesRegex(RuntimeError, "SHA-256"):
                    fetch_model("https://example.test/model", target, 7, "0" * 64)
            self.assertEqual(target.read_bytes(), b"trusted")
            self.assertFalse((Path(directory) / "best_detector.pth.download").exists())

    def test_missing_release_fails_without_repeating_the_request(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "best_detector.pth"
            missing = HTTPError("https://example.test/model", 404, "Not Found", {}, None)
            with patch("model_delivery.urlopen", side_effect=missing) as download, patch("model_delivery.time.sleep"):
                with self.assertRaisesRegex(RuntimeError, "404"):
                    fetch_model("https://example.test/model", target, 7, "0" * 64)
            self.assertEqual(download.call_count, 1)
            self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()

class CacheTests(unittest.TestCase):
    def test_verified_cache_is_offline_and_reports_completion(self):
        data=b'cached'
        with tempfile.TemporaryDirectory() as directory:
            target=Path(directory)/'model.pt'; target.write_bytes(data)
            progress=[]
            with patch('model_delivery.urlopen', side_effect=AssertionError('Network must not be used')):
                fetch_model('https://example.test/v1/model',target,len(data),hashlib.sha256(data).hexdigest(),progress=lambda a,b:progress.append((a,b)))
            self.assertEqual(progress,[(6,6)])

    def test_cancellation_cleans_partial_and_preserves_existing_file(self):
        from model_delivery import DownloadCancelled
        with tempfile.TemporaryDirectory() as directory:
            target=Path(directory)/'model.pt'; target.write_bytes(b'old')
            calls=[0]
            def cancelled():
                calls[0]+=1
                return calls[0]>=4
            with patch('model_delivery.urlopen',return_value=BytesIO(b'new')):
                with self.assertRaises(DownloadCancelled):
                    fetch_model('https://example.test/v1/model',target,3,hashlib.sha256(b'new').hexdigest(),cancelled=cancelled)
            self.assertEqual(target.read_bytes(),b'old')
            self.assertEqual(list(Path(directory).glob('*.download')),[])

    def test_truncated_download_and_mutable_url_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            target=Path(directory)/'model.pt'
            with patch('model_delivery.urlopen', side_effect=lambda *_a,**_kw:BytesIO(b'x')),patch('model_delivery.time.sleep'):
                with self.assertRaises(RuntimeError): fetch_model('https://example.test/v1/model',target,5,'0'*64)
            self.assertFalse(target.exists())
            with self.assertRaises(ValueError): fetch_model('https://github.com/a/b/releases/latest/model',target,5,'0'*64)

class LocalBundleTests(unittest.TestCase):
    def registry(self):
        return dict(registryVersion='model-delivery-2',bundleId='test_bundle',releaseTag='models-test-r1',
            compatibility={'runtime':'test-runtime'},files={'model.pt':dict(url='https://example.test/releases/download/models-test-r1/model.pt',sizeBytes=4,sha256=hashlib.sha256(b'test').hexdigest())})

    def test_future_local_bundle_uses_app_data_and_verified_offline_cache(self):
        from model_delivery import install_bundle
        with tempfile.TemporaryDirectory() as directory:
            with patch('model_delivery.urlopen',return_value=BytesIO(b'test')):
                path=install_bundle(self.registry(),directory,'test-runtime')
            self.assertEqual(path,Path(directory)/'models'/'test_bundle')
            with patch('model_delivery.urlopen',side_effect=AssertionError('offline')):
                self.assertEqual(install_bundle(self.registry(),directory,'test-runtime'),path)

    def test_incompatible_runtime_and_path_escape_are_rejected(self):
        from model_delivery import install_bundle
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):install_bundle(self.registry(),directory,'wrong-runtime')
            registry=self.registry();registry['bundleId']='../escape'
            with self.assertRaises(ValueError):install_bundle(registry,directory,'test-runtime')

class SmallConfigurationTests(unittest.TestCase):
    def test_bundled_config_never_needs_a_remote_asset_and_rejects_bad_hash(self):
        from model_delivery import install_small_config
        data='small config\n'; digest=hashlib.sha256(data.encode()).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            target=Path(directory)/'config.yaml'
            with patch('model_delivery.urlopen',side_effect=AssertionError('No remote config')):
                install_small_config(data,target,len(data),digest)
                self.assertEqual(target.read_text(),data)
                with self.assertRaises(ValueError): install_small_config('bad',target,3,'0'*64)
            self.assertEqual(target.read_text(),data)
