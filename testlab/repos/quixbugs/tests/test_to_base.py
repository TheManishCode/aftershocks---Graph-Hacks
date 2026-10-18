import pytest
from tests.load_testdata import load_json_testcases

from quixbugs.to_base import to_base


testdata = load_json_testcases(to_base.__name__)


@pytest.mark.parametrize("input_data,expected", testdata)
def test_to_base(input_data, expected):
    assert to_base(*input_data) == expected
