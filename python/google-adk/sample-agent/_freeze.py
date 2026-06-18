import importlib.metadata as m

skip = {"sample-google-adk", "pip", "setuptools", "wheel"}
# Windows-only packages present in the local venv that have no Linux build.
skip |= {"pywin32", "pywin32-ctypes", "pypiwin32", "pywinpty", "winsdk", "windows-curses"}
lines = []
for d in m.distributions():
    name = d.metadata["Name"]
    if not name or name.lower() in skip:
        continue
    lines.append(f"{name}=={d.version}")
lines = sorted(set(lines), key=str.lower)
with open("requirements.txt", "w", encoding="utf-8") as f:
    f.write("\n".join(lines) + "\n")
print("count", len(lines))
