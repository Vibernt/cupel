# frozen_string_literal: true

require 'minitest/autorun'
require 'tmpdir'
require 'fileutils'
require_relative '../lib/cupel/runner'
require_relative '../lib/cupel/mutation/run'

class MutationSafetyTest < Minitest::Test
  REPO = File.expand_path('../../..', __dir__)
  SOURCE = "module Thing\n  def self.value\n    1\n  end\nend\n"

  def fixture(test)
    Dir.mktmpdir('cupel-rubymut-safety-', File.join(REPO, '.scratch')) do |root|
      FileUtils.mkdir_p(File.join(root, 'lib'))
      FileUtils.mkdir_p(File.join(root, 'test'))
      File.write(File.join(root, 'lib/thing.rb'), SOURCE)
      File.write(File.join(root, 'test/thing_test.rb'), test)
      input = Cupel::Runner.collect(root, 1, [], [])
      yield root, input
    end
  end

  def mutate(root, input)
    Cupel::Mutation::Run.mutate(root, input, { 'changed' => { 'lib/thing.rb' => '' } },
                                { 'mutation' => { 'maxMutants' => 1, 'maxSeconds' => 30 } })
  end

  def test_engine_match_policy_unicode_camel_case_and_globstar
    match = Cupel::Mutation::Match
    schema = JSON.parse(File.read(File.join(REPO, 'spec/schemas/config.schema.json')))
    assert_equal schema.dig('properties', 'tiers', 'properties', 'pathWords', 'default'), match::DEFAULT_PATH_WORDS
    assert_equal %w[lib über auth service rb], match.tokens('lib/überAuthService.rb')
    assert_equal %w[lib ος rb], match.tokens('lib/ΟΣ.rb')
    assert match.critical?('lib/ΟΣ.rb', { 'tiers' => { 'pathWords' => ['ος'] } })
    assert match.critical?('lib/überAuthService.rb', {})
    assert match.critical?('lib/AccessTokenStore.rb', {})
    refute match.critical?('lib/regular.rb', {})
    assert match.glob?('lib/**/thing.rb', 'lib/thing.rb')
    assert match.glob?('lib/**/thing.rb', 'lib/a/b/thing.rb')
    refute match.glob?('lib/a**b.rb', 'lib/a/x/b.rb')
    assert match.glob?('lib/a**b.rb', 'lib/a/x/b.rb', loose: true)
    assert match.critical?('lib/a/x/b.rb', { 'tiers' => { 'critical' => ['lib/a**b.rb'], 'pathWords' => [] } })
    refute match.critical?('lib/regular.rb', { 'tiers' => { 'pathWords' => [], 'extraPathWords' => [] } })
    assert match.word?('-', []) # Engine treats a word with no tokens as vacuously matched.
  end

  def test_file_granularity_is_explicitly_refused_for_mutate_and_confirm
    test = <<~RUBY
      require 'minitest/autorun'
      require_relative '../lib/thing'
      class ThingTest < Minitest::Test
        def test_value = assert_equal 1, Thing.value
      end
    RUBY
    fixture(test) do |root, input|
      base = mutate(root, input)
      survivor = base['mutants'].first
      input['coverage']['granularity'] = 'file'
      input['coverage']['byFile'] = { 'test/thing_test.rb' => { 'lib/thing.rb' => '3' } }
      input['coverage']['byTest'] = {}
      error = assert_raises(RuntimeError) { mutate(root, input) }
      assert_match(/requires per-test coverage/, error.message)
      error = assert_raises(RuntimeError) do
        Cupel::Mutation::Run.confirm(root, input, base, [survivor['id']])
      end
      assert_match(/requires per-test coverage/, error.message)
    end
  end

  def test_timeout_before_mutant_load_never_credits_timeout
    test = <<~RUBY
      require 'minitest/autorun'
      sleep 9 if ENV['CUPEL_RUBY_MUTATION_SPEC']
      require_relative '../lib/thing'
      class ThingTest < Minitest::Test
        def test_value = assert_equal 1, Thing.value
      end
    RUBY
    fixture(test) do |root, input|
      result = mutate(root, input)
      assert_equal ['error'], result['mutants'].map { |row| row['status'] }.uniq
      refute result['mutants'].first.key?('killedBy')
    end
  end

  def test_crash_retry_requires_new_load_receipt
    test = <<~RUBY
      require 'minitest/autorun'
      marker = File.expand_path('../.scratch/first-loaded', __dir__)
      require_relative '../lib/thing' unless ENV['CUPEL_RUBY_MUTATION_SPEC'] && File.exist?(marker)
      class ThingTest < Minitest::Test
        def test_value
          if ENV['CUPEL_RUBY_MUTATION_SPEC'] && !File.exist?(File.expand_path('../.scratch/first-loaded', __dir__))
            File.write(File.expand_path('../.scratch/first-loaded', __dir__), 'yes')
            exit! 7
          end
          assert_equal 1, Thing.value unless ENV['CUPEL_RUBY_MUTATION_SPEC']
          assert true
        end
      end
    RUBY
    fixture(test) do |root, input|
      result = mutate(root, input)
      assert_equal ['error'], result['mutants'].map { |row| row['status'] }.uniq
      assert File.exist?(File.join(root, '.scratch/first-loaded'))
      refute result['mutants'].first.key?('killedBy')
    end
  end

  def test_confirmation_rejects_mismatched_site_metadata
    test = <<~RUBY
      require 'minitest/autorun'
      require_relative '../lib/thing'
      class ThingTest < Minitest::Test
        def test_value
          Thing.value
          assert true
        end
      end
    RUBY
    fixture(test) do |root, input|
      result = mutate(root, input)
      row = result['mutants'].first
      assert_equal 'survived', row['status']
      row['line'] += 1
      assert_raises(RuntimeError) { Cupel::Mutation::Run.confirm(root, input, result, [row['id']]) }
      row['line'] -= 1
      row['operator'] = 'wrong-operator'
      assert_raises(RuntimeError) { Cupel::Mutation::Run.confirm(root, input, result, [row['id']]) }
    end
  end
end
