require 'minitest/autorun'
require_relative '../lib/math'

class MathTest < Minitest::Test
  # cupel:critical
  def test_add
    assert_equal 4, MathFixture.add(1, 2)
  end

  [-1, 0].each do |value|
    define_method("test_classify_#{value}") do
      expected = value.negative? ? :low : :ok
      assert_equal expected, MathFixture.classify(value)
    end
  end
end
