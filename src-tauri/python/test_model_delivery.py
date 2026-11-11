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
