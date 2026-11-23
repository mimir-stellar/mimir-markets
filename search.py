import os

def search_files():
    for root, dirs, files in os.walk(r"c:\Users\HP\drips\boss\mimir-markets"):
        # Exclude hidden directories to avoid access denied
        dirs[:] = [d for d in dirs if not d.startswith('.')]
        dirs[:] = [d for d in dirs if d != "node_modules"]
        for f in files:
            if f.endswith('.ts') or f.endswith('.tsx'):
                path = os.path.join(root, f)
                try:
                    with open(path, 'r', encoding='utf-8') as file:
                        content = file.read()
                        if '"use server"' in content or "'use server'" in content:
                            print(f"Found use server in: {path}")
                        if 'origin' in content.lower():
                            # just counting or printing some info
                            pass
                except Exception as e:
                    pass

if __name__ == '__main__':
    search_files()
