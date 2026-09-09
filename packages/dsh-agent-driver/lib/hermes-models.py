"""复用 Hermes 终端 /model 的目录；stdout 仅输出允许传到 GUI 的字段。"""
import contextlib
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True
launcher, cli_args, selection = sys.argv[1:4]
sys.path.insert(0, str(Path(launcher).parent))
sys.argv = [launcher, *json.loads(cli_args)]

with contextlib.redirect_stdout(sys.stderr):
    # 与 hermes 命令相同的 profile 预解析和 dotenv 初始化。
    import hermes_cli.main  # noqa: F401
    from hermes_cli.inventory import build_models_payload, load_picker_context
    from hermes_cli.models import parse_model_input, provider_model_ids

    context = load_picker_context()
    if selection:
        provider, model = parse_model_input(selection, context.current_provider)
        context = context.with_overrides(current_provider=provider, current_model=model)
    payload = build_models_payload(context)
    result = []
    for provider in payload['providers']:
        slug = provider['slug']
        models = provider.get('models') or provider_model_ids(slug) or []
        for model in models:
            # ACP 的解析器只识别内置 provider 和 custom:name:model。
            # 自定义配置键必须显式编码，不能让它落回当前 provider。
            choice = f'{slug}:{model}'
            parsed_provider, parsed_model = parse_model_input(choice, '__unselected__')
            if parsed_provider == '__unselected__' or parsed_model != model:
                choice = f'custom:{slug}:{model}'
            result.append({
                'id': choice,
                'label': model,
                'description': provider['name'],
                'providerId': slug,
                'providerLabel': provider['name'],
                'current': choice == selection if selection else bool(provider.get('is_current') and model == payload.get('model')),
            })
print(json.dumps(result, ensure_ascii=False))
