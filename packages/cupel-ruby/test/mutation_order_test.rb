# frozen_string_literal: true

require 'minitest/autorun'
require_relative '../lib/cupel/mutation/assessment'
require_relative '../lib/cupel/mutation/order'

class MutationOrderTest < Minitest::Test
  Site = Struct.new(:source)

  class FakeAssessment < Cupel::Mutation::Assessment
    attr_reader :ran

    def initialize(outcomes)
      super('.', '.', Float::INFINITY)
      @outcomes = outcomes
      @ran = []
    end

    private

    def checked_run(_source, _test, _seconds, spec: nil)
      { timeout: false, code: 0, wall: 1, rows: [{ 'status' => 'passed' }], all_rows: [{}] }
    end

    def evaluate(_source, _site, test, _limit)
      @ran << test.fetch('id')
      @outcomes.fetch(test.fetch('id'))
    end
  end

  def tests
    [
      { 'id' => 'broad', 'file' => 'test/integration_test.rb' },
      { 'id' => 'near', 'file' => 'test/a/b_test.rb' },
      { 'id' => 'short-near', 'file' => 'test/b_test.rb' },
      { 'id' => 'history', 'file' => 'test/history_test.rb' }
    ]
  end

  def test_order_is_catch_history_then_source_name_then_input
    ordered = Cupel::Mutation::Order.tests(tests, 'lib/a/b.rb', %w[history missing history])
    assert_equal %w[history near short-near broad], ordered.map { |test| test.fetch('id') }
  end

  def test_stop_after_two_first_catch_and_targeted_full_run
    outcomes = tests.to_h { |test| [test.fetch('id'), ['killed', [test.fetch('id')]]] }

    ordinary = FakeAssessment.new(outcomes)
    assert_equal ['killed', %w[history near]], ordinary.assess(nil, Site.new('lib/a/b.rb'), tests,
                                                               catchers: ['history'])
    assert_equal %w[history near], ordinary.ran

    first = FakeAssessment.new(outcomes)
    assert_equal ['killed', ['history']], first.assess(nil, Site.new('lib/a/b.rb'), tests,
                                                       first_catch: true, catchers: ['history'])
    assert_equal ['history'], first.ran

    targeted = FakeAssessment.new(outcomes)
    assert_equal ['killed', %w[broad history near short-near].sort],
                 targeted.assess(nil, Site.new('lib/a/b.rb'), tests, targeted: true, catchers: ['history'])
    assert_equal %w[history near short-near broad], targeted.ran
  end

  def test_real_catch_precedes_a_later_timeout_without_counting_timeout_as_a_catch
    outcomes = tests.to_h { |test| [test.fetch('id'), ['survived', []]] }
    outcomes['history'] = ['killed', ['history']]
    outcomes['near'] = ['timeout', ['near']]
    assessment = FakeAssessment.new(outcomes)

    assert_equal ['killed', ['history']], assessment.assess(nil, Site.new('lib/a/b.rb'), tests,
                                                            catchers: ['history'])
    assert_equal %w[history near], assessment.ran
  end
end
