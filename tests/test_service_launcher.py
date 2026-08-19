import os
import shutil
import socket
import subprocess
import sys
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
START_SCRIPT = ROOT / "启动服务.bat"
STOP_SCRIPT = ROOT / "stop-infinite-canvas.ps1"


class ServiceLauncherContractTests(unittest.TestCase):
    def test_launcher_only_cleans_when_port_is_occupied(self):
        source = START_SCRIPT.read_text(encoding="utf-8")

        self.assertIn('set "PORT_CHECK_RESULT=%ERRORLEVEL%"', source)
        self.assertIn('if "%PORT_CHECK_RESULT%"=="10" goto clear_port', source)
        self.assertIn('if not "%PORT_CHECK_RESULT%"=="0" goto port_check_failed', source)
        self.assertIn(":start_server", source)
        self.assertIn("-ForcePortOwner -MaxAttempts 3", source)
        self.assertNotIn(":already_running", source)
        self.assertNotIn("Opening the existing service", source)

        check_index = source.index("Get-NetTCPConnection -LocalPort %APP_PORT%")
        branch_index = source.index('if "%PORT_CHECK_RESULT%"=="10" goto clear_port')
        direct_start_index = source.index("goto start_server", branch_index)
        cleanup_index = source.index(":clear_port")
        self.assertLess(check_index, branch_index)
        self.assertLess(branch_index, direct_start_index)
        self.assertLess(direct_start_index, cleanup_index)

    def test_force_mode_uses_unique_listener_pids_and_is_bounded(self):
        source = STOP_SCRIPT.read_text(encoding="utf-8")

        self.assertIn("[switch]$ForcePortOwner", source)
        self.assertIn("Select-Object -ExpandProperty OwningProcess -Unique", source)
        self.assertIn("$attempt -le $MaxAttempts", source)
        self.assertIn("Stop-Process -Id ([int]$ProcessInfo.ProcessId) -Force", source)


@unittest.skipUnless(os.name == "nt" and shutil.which("powershell"), "requires Windows PowerShell")
class ServiceLauncherWindowsIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.children = []

    def tearDown(self):
        for child in self.children:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=3)

    @staticmethod
    def reserve_free_port():
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            return sock.getsockname()[1]

    def start_child(self, code, *args):
        child = subprocess.Popen(
            [sys.executable, "-c", code, *map(str, args)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.children.append(child)
        return child

    @staticmethod
    def wait_for_listener(port, timeout=5):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                    return
            except OSError:
                time.sleep(0.05)
        raise AssertionError(f"listener on port {port} did not start")

    @staticmethod
    def port_is_listening(port):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                return True
        except OSError:
            return False

    def run_force_cleanup(self, port):
        env = os.environ.copy()
        env.update(
            {
                "STOP_SCRIPT": str(STOP_SCRIPT),
                "INFINITE_CANVAS_APP_DIR": str(ROOT),
                "TEST_SERVICE_PORT": str(port),
            }
        )
        command = (
            "$code=[IO.File]::ReadAllText($env:STOP_SCRIPT,[Text.UTF8Encoding]::new($false)); "
            "& ([ScriptBlock]::Create($code)) -Port ([int]$env:TEST_SERVICE_PORT) "
            "-ForcePortOwner -MaxAttempts 3"
        )
        return subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
            cwd=ROOT,
            env=env,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
            check=False,
        )

    def test_force_cleanup_stops_only_the_exact_listener(self):
        port = self.reserve_free_port()
        listener_code = (
            "import socket,sys,time; "
            "s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); "
            "s.bind(('127.0.0.1',int(sys.argv[1]))); s.listen(); time.sleep(60)"
        )
        listener = self.start_child(listener_code, port)
        sleeper = self.start_child("import time; time.sleep(60)")
        self.wait_for_listener(port)

        result = self.run_force_cleanup(port)

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        listener.wait(timeout=5)
        self.assertIsNotNone(listener.returncode)
        self.assertIsNone(sleeper.poll(), "a process not listening on the target port was stopped")
        self.assertFalse(self.port_is_listening(port))

    def test_force_cleanup_is_a_noop_when_port_is_free(self):
        port = self.reserve_free_port()

        result = self.run_force_cleanup(port)

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(self.port_is_listening(port))


if __name__ == "__main__":
    unittest.main()
