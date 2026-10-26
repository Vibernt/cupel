# frozen_string_literal: true

require 'minitest/autorun'
require 'tmpdir'
require_relative '../lib/cupel/static'

class StaticTest < Minitest::Test
  def test_fnv_and_masking
    assert_equal 0x4f9f2cab, Cupel::Static.fnv('hello')
    Dir.mktmpdir do |dir|
      file = File.join(dir, 'test.rb')
      File.write(file, "def test_one\n  assert_equal 1, 'secret'\nend\n")
      first = Cupel::Static.shape(file, 1)
      File.write(file, "def test_two\n  assert_equal 9, 'other'\nend\n")
      assert_equal first, Cupel::Static.shape(file, 1)
    end
  end

  def test_analysis_stops_at_method_end
    Dir.mktmpdir do |dir|
      file = File.join(dir, 'test.rb')
      File.write(file, <<~RUBY)
        # cupel:critical
        def test_one
          assert true
        end
        def test_two
          assert_equal 'foo', File.read('README.md')
          system('ruby', '-v')
        end
      RUBY
      assert_equal [['critical'], []], Cupel::Static.flags(file, 2, 'one')
      refute Cupel::Static.spawns_interpreter?(file, 2)
      assert_equal [{ 'test' => 'two', 'kind' => 'doc-wording', 'line' => 5 }],
                   Cupel::Static.flags(file, 5, 'two')[1]
      assert Cupel::Static.spawns_interpreter?(file, 5)
      File.write(file, <<~RUBY)
        def test_unrelated
          File.read('README.md')
          assert true
        end
        def test_indirect
          text = File.read('lib/app.rb')
          assert_equal 'x', text
        end
      RUBY
      assert_equal [], Cupel::Static.flags(file, 1, 'unrelated')[1]
      assert_equal [{ 'test' => 'indirect', 'kind' => 'source-text', 'line' => 5 }],
                   Cupel::Static.flags(file, 5, 'indirect')[1]
    end
  end

  def test_rails_style_block_tag_and_shape
    Dir.mktmpdir do |dir|
      file = File.join(dir, 'test.rb')
      File.write(file, <<~RUBY)
        # cupel:critical
        test 'first' do
          assert_equal 1, value
        end
        test 'second' do
          assert_equal 2, value
        end
      RUBY
      assert_equal ['critical'], Cupel::Static.flags(file, 2, 'first')[0]
      assert_equal Cupel::Static.shape(file, 2), Cupel::Static.shape(file, 5)
    end
  end

  def test_definition_title_handles_generated_minitest_test_declarations
    Dir.mktmpdir do |dir|
      file = File.join(dir, 'test.rb')
      File.write(file, <<~RUBY)
        [false, true].each do |enabled|
          test "with account\#{" in multi-tenant mode" if enabled}, the key is owned" do
            assert true
          end
        end
      RUBY
      expected = File.readlines(file)[1].split('test ', 2).last.split(' do', 2).first
      assert_equal expected, Cupel::Static.definition_title(file, 2)
    end
  end

  def test_definition_title_rejects_ambiguous_or_malformed_declarations
    Dir.mktmpdir do |dir|
      file = File.join(dir, 'test.rb')
      File.write(file, "test 'one' do; define_method('two') {}; end\n")
      error = assert_raises(RuntimeError) { Cupel::Static.definition_title(file, 1) }
      assert_match(/ambiguous test declaration/, error.message)

      File.write(file, "test do\n  assert true\nend\n")
      error = assert_raises(RuntimeError) { Cupel::Static.definition_title(file, 1) }
      assert_match(/no test name/, error.message)
    end
  end
end
