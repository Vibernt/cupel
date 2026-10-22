# A comment is not coverable.
OFFSET = 2

def add(a, b):
    return a + b + OFFSET

def classify(n):
    if n < 0:
        return 'low'
    return 'ok'

def uncalled():
    return 'unseen'
