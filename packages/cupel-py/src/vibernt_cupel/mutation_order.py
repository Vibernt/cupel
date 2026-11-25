"""Pure, deterministic pytest-unit order for one fault."""
from pathlib import PurePosixPath


def _unit(test):
    return test.get('unit', test['id'])


def _own_file(source, test_file):
    name = PurePosixPath(source.replace('\\', '/')).stem
    test_name = PurePosixPath(test_file.replace('\\', '/')).name
    return test_name in (f'test_{name}.py', f'{name}_test.py')


def order_units(tests, source, previous_catchers=()):
    """Put previous catching units, then module-named units, before the input order.

    Rows of a parametrized test stay together and keep their input order. Unknown
    historical ids are ignored, and no unit absent from ``tests`` is introduced.
    """
    groups, unit_order = {}, []
    for test in tests:
        unit = _unit(test)
        if unit not in groups:
            groups[unit] = []
            unit_order.append(unit)
        groups[unit].append(test)
    unit_by_id = {test['id']: _unit(test) for test in tests}
    own = {unit for unit, rows in groups.items() if any(_own_file(source, row['file']) for row in rows)}
    ordered, placed = [], set()

    def place(unit):
        if unit in groups and unit not in placed:
            placed.add(unit)
            ordered.append(unit)

    for test_id in previous_catchers:
        place(unit_by_id.get(test_id))
    for unit in unit_order:
        if unit in own:
            place(unit)
    for unit in unit_order:
        place(unit)
    return [test for unit in ordered for test in groups[unit]]
