class Context:
    current_provider = 'zai'
    current_model = 'fake-acp-model'
    def with_overrides(self, **kwargs):
        for key, value in kwargs.items():
            setattr(self, key, value)
        return self

def load_picker_context():
    return Context()

def build_models_payload(ctx):
    return {'model': ctx.current_model, 'providers': [
        {'slug': 'zai', 'name': '测试 Hermes', 'models': ['fake-acp-model'], 'is_current': ctx.current_provider == 'zai'},
        {'slug': 'minimax-cn', 'name': 'MiniMax', 'models': ['shared-model', 'another-model']},
        {'slug': 'qwen-coding-plan', 'name': 'qwen-coding-plan', 'models': ['shared-model'], 'api_key': 'must-not-leak'},
    ]}
