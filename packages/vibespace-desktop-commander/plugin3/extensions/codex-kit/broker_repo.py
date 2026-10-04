"""Thin adapter: preserve the tested streaming transaction engine and isolate broker receipts."""
import json
import pathlib
import sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import repo_ops

try:
    operation, input_path, state_path = sys.argv[1:4]
    state = pathlib.Path(state_path)
    if operation == 'plan':
        result = repo_ops.plan(json.loads(pathlib.Path(input_path).read_text(encoding='utf-8')))
    elif operation == 'apply':
        result = repo_ops.apply(json.loads(pathlib.Path(input_path).read_text(encoding='utf-8')), state)
    elif operation == 'rollback':
        result = repo_ops.rollback(input_path, state)
    else:
        raise ValueError('Unsupported operation')
    print(json.dumps(result, ensure_ascii=False))
except Exception as error:
    print(json.dumps({'status': 'error', 'error': str(error)}, ensure_ascii=False))
    sys.exit(1)
