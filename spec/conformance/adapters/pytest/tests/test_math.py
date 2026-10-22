import pytest
from src.math import add, classify

@pytest.fixture(scope='module')
def module_value():
    return add(0, 0)

@pytest.fixture
def function_value():
    return add(1, 1)

@pytest.mark.cupel_critical
def test_add(function_value, module_value):
    assert function_value == 4
    assert module_value == 2

@pytest.mark.parametrize('n,expected', [(-1, 'low'), (0, 'ok'), (1, 'ok')])
def test_classify(n, expected):
    assert classify(n) == expected

class TestGrouped:
    def test_add(self):
        assert add(2, 2) == 6
