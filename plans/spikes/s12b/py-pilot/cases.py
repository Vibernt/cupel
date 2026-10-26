"""Small offline pytest fixtures for dependency evidence replay."""

BASE = {
    "pyproject.toml": '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
    "src/__init__.py": "",
}

CASES = {
    "source-text-pin-plus-exec": {
        "files": {
            "src/text.py": 'hidden = "green"\n',
            "tests/test_runtime.py": "from src.text import hidden\ndef test_shape():\n    assert isinstance(hidden, str)\n",
            "tests/test_pin.py": "from pathlib import Path\ndef test_pin():\n    assert 'green' in (Path(__file__).parents[1] / 'src/text.py').read_text()\n",
        },
        "change": "src/text.py", "before": "green", "after": "red",
        "must_select": ["tests/test_pin.py", "tests/test_runtime.py"],
    },
    "cached-constant-import": {
        "files": {
            "src/constants.py": 'COLOR = "green"\n',
            "tests/test_a.py": "import src.constants\ndef test_shape():\n    assert isinstance(src.constants.COLOR, str)\n",
            "tests/test_b.py": "from src.constants import COLOR\ndef test_value():\n    assert COLOR == 'green'\n",
        },
        "change": "src/constants.py", "before": "green", "after": "red",
        "must_select": ["tests/test_a.py", "tests/test_b.py"],
    },
    "cached-import-time-data": {
        "files": {
            "src/data.txt": "green\n",
            "src/reader.py": "from pathlib import Path\nVALUE = (Path(__file__).parent / 'data.txt').read_text().strip()\n",
            "tests/test_a.py": "from src.reader import VALUE\ndef test_a():\n    assert VALUE == 'green'\n",
            "tests/test_b.py": "from src.reader import VALUE\ndef test_b():\n    assert VALUE == 'green'\n",
        },
        "change": "src/data.txt", "before": "green", "after": "red",
        "must_select": ["tests/test_a.py", "tests/test_b.py"],
    },
    "pathlib-io-os-open": {
        "files": {
            "src/data.txt": "green\n",
            "tests/test_path.py": "from pathlib import Path\ndef test_path():\n    assert (Path(__file__).parents[1] / 'src/data.txt').read_text().strip() == 'green'\n",
            "tests/test_io.py": "import io\nfrom pathlib import Path\ndef test_io():\n    with io.open(Path(__file__).parents[1] / 'src/data.txt') as f:\n        assert f.read().strip() == 'green'\n",
            "tests/test_os.py": "import os\nfrom pathlib import Path\ndef test_os():\n    fd = os.open(Path(__file__).parents[1] / 'src/data.txt', os.O_RDONLY)\n    try:\n        assert os.read(fd, 100).strip() == b'green'\n    finally:\n        os.close(fd)\n",
        },
        "change": "src/data.txt", "before": "green", "after": "red",
        "must_select": ["tests/test_path.py", "tests/test_io.py", "tests/test_os.py"],
    },
    "negative-probe-addition": {
        "files": {
            "tests/test_probe.py": "from pathlib import Path\ndef test_missing():\n    assert not (Path(__file__).parents[1] / 'src/optional.txt').exists()\n",
        },
        "change": "src/optional.txt", "create": "now present\n",
        "must_select": ["tests/test_probe.py"],
    },
    "directory-new-entry": {
        "files": {
            "src/old.txt": "old\n",
            "tests/test_dir.py": "import os\nfrom pathlib import Path\ndef test_listing():\n    assert 'new.txt' not in os.listdir(Path(__file__).parents[1] / 'src')\n",
        },
        "change": "src/new.txt", "create": "new\n",
        "must_select": ["tests/test_dir.py"],
    },
    "global-setup-import": {
        "files": {
            "src/setup.py": 'VALUE = "green"\n',
            "tests/conftest.py": "import pytest\nfrom src.setup import VALUE\n@pytest.fixture(autouse=True)\ndef check_setup():\n    assert VALUE == 'green'\n",
            "tests/test_a.py": "def test_a():\n    assert True\n",
            "tests/test_b.py": "def test_b():\n    assert True\n",
        },
        "change": "src/setup.py", "before": "green", "after": "red",
        "must_select": ["tests/test_a.py", "tests/test_b.py"],
    },
    "shared-memory-cross-file": {
        "files": {
            "src/state.py": "VALUE = 0\ndef prime():\n    global VALUE\n    VALUE = 1\n",
            "tests/test_a.py": "from src import state\ndef test_prime():\n    state.prime()\n    assert isinstance(state.VALUE, int)\n",
            "tests/test_b.py": "import sys\ndef test_observe():\n    assert sys.modules['src.state'].VALUE == 1\n",
        },
        "change": "src/state.py", "before": "VALUE = 1", "after": "VALUE = 2",
        "must_select": ["tests/test_a.py"], "expected_miss": True,
    },
    "project-write-transitivity": {
        "files": {
            "src/data.txt": "green\n",
            "tests/test_write.py": "from pathlib import Path\ndef test_write():\n    (Path(__file__).parents[1] / 'src/data.txt').write_text('green\\n')\n",
            "tests/test_read.py": "from pathlib import Path\ndef test_read():\n    assert (Path(__file__).parents[1] / 'src/data.txt').read_text().strip() == 'green'\n",
        },
        "incomplete": "project-write",
    },
    "child-process": {
        "files": {"tests/test_process.py": "import subprocess, sys\ndef test_process():\n    subprocess.run([sys.executable, '-c', 'pass'], check=True)\n"},
        "incomplete": "subprocess.Popen",
    },
    "thread": {
        "files": {"tests/test_thread.py": "import threading\ndef test_thread():\n    t = threading.Thread(target=lambda: None)\n    t.start()\n    t.join()\n"},
        "incomplete": "thread-start",
    },
    "native": {
        "files": {"tests/test_native.py": "import ctypes\ndef test_native():\n    assert ctypes.CDLL(None) is not None\n"},
        "incomplete": "ctypes.dlopen",
    },
    "external-read": {
        "files": {"tests/test_external.py": "import os\nfrom pathlib import Path\ndef test_external():\n    assert Path(os.environ['PILOT_EXTERNAL']).read_text() == 'green\\n'\n"},
        "incomplete": "external-read-or-write",
    },
    "symlink-boundary": {
        "files": {"tests/test_link.py": "from pathlib import Path\ndef test_link():\n    assert (Path(__file__).parents[1] / 'src/link.txt').read_text() == 'green\\n'\n"},
        "link": "src/link.txt", "incomplete": "symlink-path",
    },
    "untracked-descriptor": {
        "files": {"tests/test_fd.py": "import os\ndef test_fd():\n    fd = os.dup(1)\n    try:\n        assert os.fstat(fd).st_mode\n    finally:\n        os.close(fd)\n"},
        "incomplete": "untracked-descriptor",
    },
    "failed-import": {
        "files": {"tests/test_optional.py": "try:\n    import src.optional\nexcept ModuleNotFoundError:\n    optional = None\nelse:\n    optional = src.optional\ndef test_optional_absent():\n    assert optional is None\n"},
        "incomplete": "failed-import-unproven",
    },
}
