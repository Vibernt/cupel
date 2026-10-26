# frozen_string_literal: true

require 'minitest/autorun'
require 'json'
require 'tmpdir'
require 'fileutils'
require_relative '../lib/cupel/runner'

class CollectorTest < Minitest::Test
  REPO = File.expand_path('../../..', __dir__)
  FIXTURE = File.join(REPO, 'spec/conformance/adapters/minitest')

  def with_fixture
    scratch = File.join(REPO, '.scratch')
    FileUtils.mkdir_p(scratch)
    Dir.mktmpdir('cupel-ruby-fixture-', scratch) do |root|
      FileUtils.cp_r(File.join(FIXTURE, '.'), root)
      yield root
    end
  end

  def test_fixture_matches_hand_written_expectations
    with_fixture do |root|
      input = Cupel::Runner.collect(root, 2, [], [])
      expected = JSON.parse(File.read(File.join(root, 'expected.json')))
      assert_equal expected['sources'], input['sources']
      assert_equal expected['tests'].map { |test| test['id'] }, input['tests'].map { |test| test['id'] }
      expected['tests'].zip(input['tests']).each do |want, got|
        want.each { |key, value| assert_equal value, got[key] unless value == '$absent' }
        refute got.key?('unit') if want['unit'] == '$absent'
        assert_equal 2, got['durationsMs'].length
      end
      assert_equal expected['coverage'], input['coverage']
      assert_equal [], input['brittleness']
      assert input['shapes'].values.all? { |shape| !shape.empty? && shape == shape.uniq.sort }
    end
  end

  def test_recheck_runs_each_row_alone
    with_fixture do |root|
      unit = 'test/math_test.rb::MathTest > "test_classify_#{value}"'
      input = Cupel::Runner.collect(root, 1, [unit], [])
      assert_equal [unit], input.dig('coverage', 'rechecked')
      assert_equal '10-11', input.dig('coverage', 'byTest', 'test/math_test.rb::MathTest > test_classify_-1', 'lib/math.rb')
      assert_equal '10,13', input.dig('coverage', 'byTest', 'test/math_test.rb::MathTest > test_classify_0', 'lib/math.rb')
    end
  end

  def test_loop_unit_survives_shift_and_three_runs_mark_unstable_branch
    scratch = File.join(REPO, '.scratch')
    FileUtils.mkdir_p(scratch)
    Dir.mktmpdir('cupel-ruby-k10-k13-', scratch) do |root|
      FileUtils.mkdir_p(File.join(root, 'lib'))
      FileUtils.mkdir_p(File.join(root, 'test'))
      FileUtils.mkdir_p(File.join(root, '.scratch'))
      File.write(File.join(root, '.scratch/count'), '0')
      File.write(File.join(root, 'lib/branch.rb'), <<~RUBY)
        module Branch
          def self.pick(n)
            if n.odd?
              1
            else
              2
            end
          end
        end
      RUBY
      body = <<~RUBY
        require 'minitest/autorun'
        require_relative '../lib/branch'
        class BranchTest < Minitest::Test
          counter = File.expand_path('../.scratch/count', __dir__)
          n = File.read(counter).to_i
          File.write(counter, (n + 1).to_s)
          [1, 2].each do |value|
            define_method("test_pick_\#{value}") do
              assert_equal(n.odd? ? 1 : 2, Branch.pick(n))
            end
          end
        end
      RUBY
      file = File.join(root, 'test/branch_test.rb')
      File.write(file, body)
      first = Cupel::Runner.collect(root, 3, [], [])
      assert_equal ['test/branch_test.rb::BranchTest > "test_pick_#{value}"'], first['tests'].map { |row| row['unit'] }.uniq
      assert_match(/4/, first.dig('coverage', 'unstable', 'lib/branch.rb'))
      assert_match(/6/, first.dig('coverage', 'unstable', 'lib/branch.rb'))
      File.write(file, "\n\n\n#{body}")
      File.write(File.join(root, '.scratch/count'), '0')
      shifted = Cupel::Runner.collect(root, 3, [], [])
      assert_equal first['tests'].map { |row| row['unit'] }, shifted['tests'].map { |row| row['unit'] }
    end
  end

  def test_generated_minitest_dsl_tests_share_their_source_declaration_unit
    with_fixture do |root|
      File.write(File.join(root, 'test/generated_test.rb'), <<~RUBY)
        require 'minitest/autorun'
        class GeneratedTest < Minitest::Test
          def self.test(name, &block)
            define_method("test_\#{name.gsub(/\\W+/, '_')}", &block)
          end

          [false, true].each do |enabled|
            test "generated\#{" in enabled mode" if enabled}" do
              assert_equal enabled, !!enabled
            end
          end
        end
      RUBY

      input = Cupel::Runner.collect(root, 1, [], [])
      generated = input['tests'].select { |row| row['file'] == 'test/generated_test.rb' }
      assert_equal 2, generated.length, input['tests'].map { |row| [row['id'], row['file']] }.inspect
      assert_equal ['passed', 'passed'], generated.map { |row| row['status'] }
      declaration = File.readlines(File.join(root, 'test/generated_test.rb'))[7]
      title = declaration.split('test ', 2).last.split(' do', 2).first
      assert_equal ["test/generated_test.rb::GeneratedTest > #{title}"], generated.map { |row| row['unit'] }.uniq
    end
  end

  def test_failed_and_skipped_tests_keep_outcomes_and_setup_teardown_coverage
    Dir.mktmpdir('cupel-ruby-test-') do |root|
      FileUtils.mkdir_p(File.join(root, 'lib'))
      FileUtils.mkdir_p(File.join(root, 'test'))
      File.write(File.join(root, 'lib/app.rb'), "module App\n  def self.touch\n    1\n  end\nend\n")
      File.write(File.join(root, 'test/app_test.rb'), <<~RUBY)
        require 'minitest/autorun'
        require_relative '../lib/app'
        class AppTest < Minitest::Test
          def setup
            App.touch
          end
          def teardown
            App.touch
          end
          def test_failure
            assert_equal 2, App.touch
          end
          def test_skip
            skip 'intentional'
          end
        end
      RUBY
      input = Cupel::Runner.collect(root, 1, [], [])
      assert_equal %w[failed skipped], input['tests'].map { |test| test['status'] }
      input['coverage']['byTest'].each_value do |covered|
        assert_equal '3', covered['lib/app.rb']
      end
    end
  end

  def test_rails_command_rechecks_with_name_filter
    Dir.mktmpdir('cupel-ruby-rails-') do |root|
      FileUtils.mkdir_p(File.join(root, 'bin'))
      FileUtils.mkdir_p(File.join(root, 'test'))
      File.write(File.join(root, 'bin/rails'), <<~RUBY)
        ARGV.shift if ARGV.first == 'test'
        require_relative '../test/app_test'
      RUBY
      File.write(File.join(root, 'test/app_test.rb'), <<~RUBY)
        require 'minitest/autorun'
        class AppTest < Minitest::Test
          def test_one
            assert true
          end
          def test_two
            assert true
          end
        end
      RUBY
      unit = 'test/app_test.rb::AppTest > test_one'
      input = Cupel::Runner.collect(root, 1, [unit], ['bin/rails', 'test'])
      assert_equal 2, input['tests'].length
      assert_equal [unit], input.dig('coverage', 'rechecked')
    end
  end

  def test_rake_command_rechecks_with_testopts
    skip 'rake unavailable' unless system('ruby', '-S', 'rake', '--version', out: File::NULL, err: File::NULL)

    Dir.mktmpdir('cupel-ruby-rake-') do |root|
      FileUtils.mkdir_p(File.join(root, 'test'))
      File.write(File.join(root, 'Rakefile'), <<~RUBY)
        require 'rake/testtask'
        Rake::TestTask.new(:test) do |task|
          task.libs = ['test']
          task.pattern = 'test/**/*_test.rb'
        end
      RUBY
      File.write(File.join(root, 'test/app_test.rb'), <<~RUBY)
        require 'minitest/autorun'
        class AppTest < Minitest::Test
          def test_one
            assert true
          end
          def test_two
            assert true
          end
        end
      RUBY
      unit = 'test/app_test.rb::AppTest > test_one'
      input = Cupel::Runner.collect(root, 1, [unit], ['rake', 'test'])
      assert_equal 2, input['tests'].length
      assert_equal [unit], input.dig('coverage', 'rechecked')
    end
  end

  def test_default_run_keeps_cross_file_suite_setup
    Dir.mktmpdir('cupel-ruby-multifile-') do |root|
      FileUtils.mkdir_p(File.join(root, 'test'))
      FileUtils.mkdir_p(File.join(root, 'lib'))
      File.write(File.join(root, 'lib/shared.rb'), "module SharedSource\n  VALUE = 7\nend\n")
      File.write(File.join(root, 'test/a_test.rb'), <<~RUBY)
        require 'minitest/autorun'
        require_relative '../lib/shared'
        SHARED_TEST_VALUE = SharedSource::VALUE
        class ATest < Minitest::Test
          def test_one
            assert_equal 7, SHARED_TEST_VALUE
          end
        end
      RUBY
      File.write(File.join(root, 'test/b_test.rb'), <<~RUBY)
        class BTest < Minitest::Test
          def test_two
            assert_equal 7, SHARED_TEST_VALUE
          end
        end
      RUBY
      input = Cupel::Runner.collect(root, 1, [], [])
      assert_equal %w[passed passed], input['tests'].map { |test| test['status'] }
      assert_equal 2, input['tests'].length
      assert_equal '1-2', input.dig('coverage', 'setup', 'test/a_test.rb', 'lib/shared.rb')
      refute input.dig('coverage', 'setup', 'test/b_test.rb')&.key?('lib/shared.rb')
    end
  end

  def test_bundled_project_loads_test_and_spec_helpers
    scratch = File.join(REPO, '.scratch')
    FileUtils.mkdir_p(scratch)
    Dir.mktmpdir('cupel-ruby-bundle-', scratch) do |root|
      FileUtils.mkdir_p(File.join(root, 'lib'))
      FileUtils.mkdir_p(File.join(root, 'test'))
      FileUtils.mkdir_p(File.join(root, 'spec'))
      File.write(File.join(root, 'Gemfile'), "gem 'minitest', '= 6.0.0'\n")
      File.write(File.join(root, 'lib/value.rb'), "module Value\n  def self.answer = 42\nend\n")
      File.write(File.join(root, 'spec/support.rb'), "SPEC_SUPPORT = true\n")
      File.write(File.join(root, 'test/test_helper.rb'), "require 'minitest/autorun'\nrequire 'value'\nrequire 'support'\n")
      File.write(File.join(root, 'test/value_test.rb'), <<~RUBY)
        require 'test_helper'
        class ValueTest < Minitest::Test
          def test_bundled_paths
            assert defined?(Bundler)
            assert SPEC_SUPPORT
            assert_equal 42, Value.answer
          end
        end
      RUBY
      input = Cupel::Runner.collect(root, 1, [], [])
      assert_equal ['passed'], input['tests'].map { |row| row['status'] }
      assert_equal 'test/value_test.rb', input['tests'][0]['file']

      FileUtils.mkdir_p(File.join(root, 'gemfiles'))
      custom_gemfile = File.join(root, 'gemfiles/local.gemfile')
      FileUtils.mv(File.join(root, 'Gemfile'), custom_gemfile)
      previous = ENV['BUNDLE_GEMFILE']
      begin
        ENV['BUNDLE_GEMFILE'] = custom_gemfile
        input = Cupel::Runner.collect(root, 1, [], [])
        assert_equal ['passed'], input['tests'].map { |row| row['status'] }
      ensure
        previous ? ENV['BUNDLE_GEMFILE'] = previous : ENV.delete('BUNDLE_GEMFILE')
      end
    end
  end

  def test_load_failure_keeps_exception_message_at_start_of_stderr
    scratch = File.join(REPO, '.scratch')
    FileUtils.mkdir_p(scratch)
    Dir.mktmpdir('cupel-ruby-error-', scratch) do |root|
      FileUtils.mkdir_p(File.join(root, 'test'))
      File.write(File.join(root, 'test/broken_test.rb'), <<~RUBY)
        def fail_deeply(level)
          return raise 'FIRST_LINE_SENTINEL' if level.zero?
          fail_deeply(level - 1)
        end
        fail_deeply(60)
      RUBY
      error = assert_raises(RuntimeError) { Cupel::Runner.collect(root, 1, [], []) }
      assert_match(/FIRST_LINE_SENTINEL \(RuntimeError\)/, error.message)
      assert_match(/\.\.\./, error.message)
    end
  end
end
