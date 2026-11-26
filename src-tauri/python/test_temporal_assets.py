import hashlib
import io
from pathlib import Path
import tempfile
import unittest

from hybrid.temporal_assets import fetch_checked


class Response(io.BytesIO):
    pass


class TemporalAssetsTests(unittest.TestCase):
    def specification(self, data=b"verified-weights"):
        return {"url": "https://model.invalid/pinned", "sizeBytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest()}

    def test_verified_cache_never_downloads_or_executes_remote_code(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/"model.pth"
            path.write_bytes(b"verified-weights")
            result = fetch_checked(path, self.specification(), lambda *_a, **_kw:self.fail("Unexpected network"))
            self.assertEqual(result, path)

    def test_download_is_published_only_after_size_and_hash_validation(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/"model.pth"
            self.assertEqual(fetch_checked(path,self.specification(),lambda *_a,**_kw:Response(b"verified-weights")),path)
            self.assertEqual(path.read_bytes(),b"verified-weights")
            self.assertFalse(list(Path(tmp).glob("*.partial")))

    def test_truncated_oversized_and_corrupted_payloads_are_not_published(self):
        for data in (b"short",b"verified-weightz",b"verified-weights-too-long"):
            with self.subTest(data=data), tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp)/"model.pth"
                with self.assertRaises(RuntimeError):
                    fetch_checked(path,self.specification(),lambda *_a,**_kw:Response(data))
                self.assertFalse(path.exists())
                self.assertFalse(list(Path(tmp).glob("*.partial")))

    def test_failed_replacement_preserves_existing_file_and_cleans_partial(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/"model.pth"
            path.write_bytes(b"old-invalid-cache")
            with self.assertRaises(RuntimeError):
                fetch_checked(path,self.specification(),lambda *_a,**_kw:Response(b"bad"))
            self.assertEqual(path.read_bytes(),b"old-invalid-cache")
            self.assertFalse(list(Path(tmp).glob("*.partial")))

    def test_interrupted_network_does_not_create_model(self):
        def fail(*_a,**_kw):raise OSError("connection interrupted")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/"model.pth"
            with self.assertRaises(RuntimeError):fetch_checked(path,self.specification(),fail)
            self.assertFalse(path.exists())
            self.assertFalse(list(Path(tmp).glob("*.partial")))


if __name__ == "__main__":unittest.main()
