"""Do not silently approve tracking tests skipped for missing dependencies."""
import sys
from pathlib import Path
import unittest
from python_test_policy import permitted_skip

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / 'src-tauri/python'))
suite = unittest.defaultTestLoader.discover(str(root / 'src-tauri/python'), pattern='test_*.py')
result = unittest.TextTestRunner(verbosity=1).run(suite)
unexpected = [(test.id(), reason) for test, reason in result.skipped
              if not permitted_skip(test.id(), reason, sys.platform)]
if unexpected:
    print('Testes obrigatórios ignorados:', unexpected, file=sys.stderr)
sys.exit(0 if result.wasSuccessful() and not unexpected else 1)
