# frozen_string_literal: true

require 'minitest/autorun'
require 'fileutils'
require 'tmpdir'
require 'open3'
require 'rbconfig'
require_relative '../lib/cupel/runner'
require_relative '../lib/cupel/mutation/run'

class MutationTest < Minitest::Test
  REPO = File.expand_path('../../..', __dir__)

  def fixture(source, test)
    Dir.mktmpdir('cupel-rubymut-test-', File.join(REPO, '.scratch')) do |root|
      FileUtils.mkdir_p(File.join(root, 'lib'))
      FileUtils.mkdir_p(File.join(root, 'test'))
      File.write(File.join(root, 'lib/thing.rb'), source)
      File.write(File.join(root, 'test/thing_test.rb'), test)
      yield root
    end
  end

  def input_for(root)
    Cupel::Runner.collect(root, 1, [], [])
  end

  def mutate(root, input, cap = 10)
    Cupel::Mutation::Run.mutate(root, input, { 'changed' => { 'lib/thing.rb' => '' } },
                                { 'mutation' => { 'maxMutants' => cap, 'maxSeconds' => 30 } })
  end

  def test_loader_changes_execution_but_preserves_path_relative_require_and_text_pin
    source = <<~RUBY
      require_relative 'helper'
      module Thing
        PATH = __FILE__
        def self.value = Helper::VALUE + 1
      end
    RUBY
    test = <<~RUBY
      require 'minitest/autorun'
      require_relative '../lib/thing'
      class ThingTest < Minitest::Test
        def test_behavior
          assert_equal 10, Thing.value
          assert_equal File.expand_path('../lib/thing.rb', __dir__), Thing::PATH
        end
        def test_source_pin
          Thing.value
          assert_includes File.read(File.expand_path('../lib/thing.rb', __dir__)), 'Helper::VALUE + 1'
        end
      end
    RUBY
    fixture(source, test) do |root|
      File.write(File.join(root, 'lib/helper.rb'), "module Helper\n  VALUE = 9\nend\n")
      input = input_for(root)
      hash = input.dig('sources', 'lib/thing.rb', 'hash')
      result = mutate(root, input)
      site = result.fetch('mutants').find { |row| row['line'] == 4 && row['operator'] == 'number-replace' }
      assert_equal 'killed', site.fetch('status')
      assert_equal ['test/thing_test.rb::ThingTest > test_behavior'], site.fetch('killedBy')
      assert_equal hash, "sha256:#{Digest::SHA256.file(File.join(root, 'lib/thing.rb')).hexdigest}"
    end
  end

  def test_survivor_confirmation_and_same_id_lost_kill_shape
    source = <<~RUBY
      module Thing
        def self.value
          if ENV['KEEP_TRUE'] != 'never'
            1
          else
            1
          end
        end
      end
    RUBY
    test = <<~RUBY
      require 'minitest/autorun'
      require_relative '../lib/thing'
      class ThingTest < Minitest::Test
        def test_value
          assert_equal 1, Thing.value
        end
      end
    RUBY
    fixture(source, test) do |root|
      input = input_for(root)
      base = mutate(root, input)
      killed = base['mutants'].find { |row| row['line'] == 4 }
      survivor = base['mutants'].find { |row| row['line'] == 3 }
      assert_equal 'killed', killed['status']
      assert_equal 'survived', survivor['status']
      confirmed = Cupel::Mutation::Run.confirm(root, input, base, [survivor['id']])
      assert_equal 'survived', confirmed['mutants'].find { |row| row['id'] == survivor['id'] }['status']

      File.write(File.join(root, 'test/thing_test.rb'), test.sub('assert_equal 1, Thing.value', 'Thing.value; assert true'))
      head_input = input_for(root)
      head = mutate(root, head_input)
      same = head['mutants'].find { |row| row['id'] == killed['id'] }
      assert_equal 'survived', same['status']
      assert_equal killed['id'], same['id']
    end
  end

  def test_source_change_and_unsupported_load_refuse_outcome
    source = "module Thing\n  def self.value = 1\nend\n"
    normal = <<~RUBY
      require 'minitest/autorun'
      require_relative '../lib/thing'
      class ThingTest < Minitest::Test
        def test_value = assert_equal 1, Thing.value
      end
    RUBY
    fixture(source, normal) do |root|
      input = input_for(root)
      File.write(File.join(root, 'lib/thing.rb'), "# changed\n#{source}")
      assert_raises(Cupel::Mutation::SourceError) { mutate(root, input) }
    end
    loaded = normal.sub("require_relative '../lib/thing'", "load File.expand_path('../lib/thing.rb', __dir__)")
    fixture(source, loaded) do |root|
      input = input_for(root)
      result = mutate(root, input)
      assert_equal ['error'], result['mutants'].map { |row| row['status'] }.uniq
      assert_equal [], result['targeted']
    end
    wrapped = normal.sub("require_relative '../lib/thing'", "load File.expand_path('../lib/thing.rb', __dir__), true")
    fixture(source, wrapped) do |root|
      # Wrapped load has no direct module constant; a passing row still exercises setup coverage.
      File.write(File.join(root, 'test/thing_test.rb'), wrapped.sub('assert_equal 1, Thing.value', 'assert true'))
      input = input_for(root)
      result = mutate(root, input)
      assert_equal ['error'], result['mutants'].map { |row| row['status'] }.uniq
    end
  end

  def test_source_write_during_baseline_is_refused
    source = "module Thing\n  def self.value = 1\nend\n"
    test = <<~RUBY
      require 'minitest/autorun'
      require_relative '../lib/thing'
      class ThingTest < Minitest::Test
        def test_value
          path = File.expand_path('../lib/thing.rb', __dir__)
          File.write(path, File.read(path) + "\\n") if ENV['CUPEL_RUBY_RESULT']
          assert_equal 1, Thing.value
        end
      end
    RUBY
    fixture(source, test) do |root|
      # Collector itself runs the test, so collect first without the writer and then restore it.
      safe = test.sub("File.write(path, File.read(path) + \"\\n\") if ENV['CUPEL_RUBY_RESULT']", 'nil')
      File.write(File.join(root, 'test/thing_test.rb'), safe)
      input = input_for(root)
      File.write(File.join(root, 'test/thing_test.rb'), test)
      assert_raises(Cupel::Mutation::SourceError) { mutate(root, input) }
    end
  end

  def test_ripper_byte_offsets_after_unicode_and_invalid_syntax_refusal
    text = "module Thing\n  def self.value = 'é'.bytesize + 1\nend\n"
    site = Cupel::Mutation::Sites.generate('lib/thing.rb', text).find { |entry| entry.original == '1' }
    assert_includes site.apply(text), "'é'.bytesize + 0"
    RubyVM::InstructionSequence.compile(site.apply(text), 'lib/thing.rb', 'lib/thing.rb', 1)

    test = <<~RUBY
      require 'minitest/autorun'
      require_relative '../lib/thing'
      class ThingTest < Minitest::Test
        def test_value = assert_equal 3, Thing.value
      end
    RUBY
    fixture(text, test) do |root|
      input = input_for(root)
      result = mutate(root, input)
      assert_equal 'killed', result['mutants'].find { |row| row['id'] == site.id }['status']
      invalid = "module Thing\n  def self.value = 1\n"
      File.write(File.join(root, 'lib/thing.rb'), invalid)
      input['sources']['lib/thing.rb']['hash'] = "sha256:#{Digest::SHA256.hexdigest(invalid)}"
      assert_raises(Cupel::Mutation::SourceError) { mutate(root, input) }
    end
  end

  def test_duplicate_require_loads_one_mutant_once
    source = <<~RUBY
      $thing_loads = ($thing_loads || 0) + 1
      module Thing
        def self.value = 1
      end
    RUBY
    test = <<~RUBY
      require 'minitest/autorun'
      require_relative '../lib/thing'
      require_relative '../lib/thing'
      class ThingTest < Minitest::Test
        def test_value
          assert_equal 1, $thing_loads
          assert_equal 1, Thing.value
        end
      end
    RUBY
    fixture(source, test) do |root|
      result = mutate(root, input_for(root))
      assert_equal 'killed', result['mutants'].find { |row| row['line'] == 3 }['status']
    end
  end

  def test_mutant_run_source_write_and_linked_source_are_refused
    source = "module Thing\n  def self.value = 1\nend\n"
    test = <<~RUBY
      require 'minitest/autorun'
      require_relative '../lib/thing'
      class ThingTest < Minitest::Test
        def test_value
          if ENV['CUPEL_RUBY_MUTATION_SPEC']
            path = File.expand_path('../lib/thing.rb', __dir__)
            File.write(path, File.read(path) + "\\n")
          end
          assert_equal 1, Thing.value
        end
      end
    RUBY
    fixture(source, test) do |root|
      input = input_for(root)
      assert_raises(Cupel::Mutation::SourceError) { mutate(root, input) }
    end
    fixture(source, test) do |root|
      input = input_for(root)
      path = File.join(root, 'lib/thing.rb')
      extra = File.join(root, 'lib/another.rb')
      File.link(path, extra)
      assert_raises(Cupel::Mutation::SourceError) { mutate(root, input) }
      File.unlink(extra)
      File.rename(path, extra)
      File.symlink(extra, path)
      assert_raises(Cupel::Mutation::SourceError) { mutate(root, input) }
    end
  end

  def test_cli_mutate_and_confirm_emit_standalone_mutation_objects
    source = "module Thing\n  def self.value = ENV['VALUE'] == 'never' ? 1 : 1\nend\n"
    test = <<~RUBY
      require 'minitest/autorun'
      require_relative '../lib/thing'
      class ThingTest < Minitest::Test
        def test_value = assert_equal 1, Thing.value
      end
    RUBY
    fixture(source, test) do |root|
      input = input_for(root)
      input_file = File.join(root, '.input.json')
      scope_file = File.join(root, '.scope.json')
      mutation_file = File.join(root, '.mutation.json')
      File.write(input_file, JSON.generate(input))
      File.write(scope_file, JSON.generate('changed' => { 'lib/thing.rb' => '' }))
      executable = File.join(REPO, 'packages/cupel-ruby/bin/cupel-ruby')
      stdout, stderr, status = Open3.capture3(RbConfig.ruby, executable, 'mutate', '--root', root,
                                              '--input', input_file, '--scope', scope_file)
      assert status.success?, stderr
      mutation = JSON.parse(stdout)
      assert_equal %w[mutants sampled seed targeted], mutation.keys.sort
      survivor = mutation['mutants'].find { |row| row['status'] == 'survived' }
      File.write(mutation_file, stdout)
      confirmed, error, status = Open3.capture3(RbConfig.ruby, executable, 'confirm', '--root', root,
                                                '--input', input_file, '--mutation', mutation_file,
                                                '--ids', survivor['id'])
      assert status.success?, error
      assert_equal 'survived', JSON.parse(confirmed)['mutants'].find { |row| row['id'] == survivor['id'] }['status']
    end
  end

  def test_targeted_and_critical_scope_only_mark_completed_units
    source = "module Thing\n  def self.value\n    1\n  end\nend\n"
    test = <<~RUBY
      require 'minitest/autorun'
      require_relative '../lib/thing'
      class ThingTest < Minitest::Test
        def test_value = assert_equal 1, Thing.value
      end
    RUBY
    fixture(source, test) do |root|
      input = input_for(root)
      id = input['tests'].first.fetch('id')
      config = { 'mutation' => { 'maxMutants' => 1, 'maxSeconds' => 30 } }
      targeted = Cupel::Mutation::Run.mutate(root, input, { 'targeted' => [id] }, config)
      assert_equal [id], targeted['targeted']
      assert_equal 1, targeted['mutants'].length
      critical = Cupel::Mutation::Run.mutate(root, input, { 'critical' => true },
                                              config.merge('tiers' => { 'critical' => ['lib/thing.rb'] }))
      assert_equal 1, critical['mutants'].length
      assert_equal [], critical['targeted']
    end
  end

  def test_unverified_minitest_version_is_refused_before_mutation
    actual = Minitest::VERSION
    Minitest.send(:remove_const, :VERSION)
    Minitest.const_set(:VERSION, '0.0.0')
    error = assert_raises(RuntimeError) do
      Cupel::Mutation::Run.mutate(REPO, {}, { 'changed' => {} })
    end
    assert_match(/requires MRI Ruby 4\.0\.7 and Minitest 6\.0\.0/, error.message)
    error = assert_raises(RuntimeError) do
      Cupel::Mutation::Run.confirm(REPO, {}, {}, [])
    end
    assert_match(/requires MRI Ruby 4\.0\.7 and Minitest 6\.0\.0/, error.message)
  ensure
    Minitest.send(:remove_const, :VERSION)
    Minitest.const_set(:VERSION, actual)
  end

  def test_seeded_budget_does_not_claim_partly_sampled_target
    source = "module Thing\n  def self.value\n    1 + 2\n  end\nend\n"
    test = <<~RUBY
      require 'minitest/autorun'
      require_relative '../lib/thing'
      class ThingTest < Minitest::Test
        def test_value = assert_equal 3, Thing.value
      end
    RUBY
    fixture(source, test) do |root|
      input = input_for(root)
      id = input['tests'].first.fetch('id')
      scope = { 'targeted' => [id] }
      config = { 'mutation' => { 'maxMutants' => 1, 'maxSeconds' => 30, 'seed' => 7 } }
      first = Cupel::Mutation::Run.mutate(root, input, scope, config)
      second = Cupel::Mutation::Run.mutate(root, input, scope, config)
      assert_equal first, second
      assert_equal true, first['sampled']
      assert_equal [], first['targeted']
      assert_equal 1, first['mutants'].length
    end
  end

  def test_mutant_process_crash_is_error_after_retry
    source = "module Thing\n  def self.value\n    1\n  end\nend\n"
    test = <<~RUBY
      require 'minitest/autorun'
      require_relative '../lib/thing'
      class ThingTest < Minitest::Test
        def test_value
          if ENV['CUPEL_RUBY_MUTATION_SPEC']
            counter = File.expand_path('../.scratch/crashes', __dir__)
            File.write(counter, (File.exist?(counter) ? File.read(counter).to_i + 1 : 1).to_s)
            exit! 7
          end
          assert_equal 1, Thing.value
        end
      end
    RUBY
    fixture(source, test) do |root|
      result = mutate(root, input_for(root))
      assert_equal ['error'], result['mutants'].map { |row| row['status'] }.uniq
      assert_equal '2', File.read(File.join(root, '.scratch/crashes'))
      assert_equal [], result['targeted']
    end
  end

  def test_timeout_requires_a_known_good_unmutated_probe
    source = "module Thing\n  def self.value\n    1\n  end\nend\n"
    test = <<~RUBY
      require 'minitest/autorun'
      require_relative '../lib/thing'
      class ThingTest < Minitest::Test
        def test_value
          if ENV['CUPEL_RUBY_MUTATION_SPEC']
            File.write(File.expand_path('../.scratch/mutant-started', __dir__), 'yes')
            sleep 9
          elsif File.exist?(File.expand_path('../.scratch/mutant-started', __dir__)) && ENV['FAIL_PROBE']
            flunk 'known-good probe failed'
          end
          assert_equal 1, Thing.value
        end
      end
    RUBY
    fixture(source, test) do |root|
      input = input_for(root)
      result = mutate(root, input)
      assert_equal ['timeout'], result['mutants'].map { |row| row['status'] }.uniq
      assert_equal [input['tests'].first['id']], result['mutants'].first['killedBy']
    end
    fixture(source, test) do |root|
      input = input_for(root)
      prior = ENV['FAIL_PROBE']
      begin
        ENV['FAIL_PROBE'] = '1'
        result = mutate(root, input)
        assert_equal ['error'], result['mutants'].map { |row| row['status'] }.uniq
      ensure
        prior ? ENV['FAIL_PROBE'] = prior : ENV.delete('FAIL_PROBE')
      end
    end
  end
end
