def parse_model_input(value, current):
    parts = value.split(':')
    if parts[0] == 'custom' and len(parts) > 2:
        return ':'.join(parts[:2]), ':'.join(parts[2:])
    if parts[0] in ['zai', 'minimax-cn']:
        return parts[0], ':'.join(parts[1:])
    return current, value

def provider_model_ids(slug):
    return []
