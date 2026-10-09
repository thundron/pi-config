#!/usr/bin/env python3
"""Ensure the RPC harness never sends memory tests to a live registry."""
import os
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

# Match the other test runners: leave no generated files in the checkout.
sys.dont_write_bytecode = True
import harness


class StopBeforeLaunch(Exception):
    pass


class HarnessSafetyTest(unittest.TestCase):
    def test_memory_registry_is_isolated(self):
        test = harness.s_memories()
        self.assertIsNone(test.setup, "memory setup must not delete the live registry")
        with tempfile.TemporaryDirectory(prefix="pi-harness-safety-") as directory:
            memory = Path(directory) / "MEMORY.md"
            memory.write_text("user's durable facts\n")
            launched_cwd = None

            def capture_launch(*args, **kwargs):
                nonlocal launched_cwd
                launched_cwd = Path(kwargs["cwd"])
                self.assertEqual(kwargs["env"]["PI_MEMORIES_DIR"], str(launched_cwd / "memories"))
                self.assertNotEqual(kwargs["env"]["PI_MEMORIES_DIR"], directory)
                raise StopBeforeLaunch()

            with patch.dict(os.environ, {"PI_MEMORIES_DIR": directory}):
                with patch.object(harness.subprocess, "Popen", side_effect=capture_launch):
                    with self.assertRaises(StopBeforeLaunch):
                        harness.run_extension_test(test)
            self.assertEqual(memory.read_text(), "user's durable facts\n")
            self.assertIsNotNone(launched_cwd)
            self.assertFalse(launched_cwd.exists(), "harness temp directory must be cleaned on failure")


if __name__ == "__main__":
    unittest.main()
