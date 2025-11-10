# Troubleshooting Guide

This document contains solutions to common issues when working with the Perplexity AI SDK sample.

---

## npm Installation Issues

### Error: Package Not Found in Registry

**Symptom:**
```
npm ERR! code E404
npm ERR! 404 Not Found - GET https://registry.npmjs.org/@microsoft%2fagents-a365-notifications - Not found
npm ERR! 404 
npm ERR! 404  '@microsoft/agents-a365-notifications@*' is not in this registry.
npm ERR! 404 
npm ERR! 404 Note that you can also install from a
npm ERR! 404 tarball, folder, http url, or git url.
```

**Cause:**
The Microsoft Agent365 SDK packages (`@microsoft/agents-a365-*`) are not published to the public npm registry. They are built locally as `.tgz` files in the `nodejs` directory of this repository.

**Solution:**

1. **First, ensure the SDK packages are built:**
   ```powershell
   cd c:\365\Agent365\nodejs\src
   npm run build:all
   ```
   
   This creates the `.tgz` files in `c:\365\Agent365\nodejs\`:
   - `microsoft-agents-a365-notifications-2025.10.10.tgz`
   - `microsoft-agents-a365-observability-2025.10.10.tgz`
   - `microsoft-agents-a365-tooling-2025.10.10.tgz`
   - `microsoft-agents-a365-runtime-2025.10.10.tgz`

2. **Update `package.json` to reference local files:**
   
   Instead of using `"*"` versions:
   ```json
   "@microsoft/agents-a365-notifications": "*",
   ```
   
   Use `file:` references to the `.tgz` files:
   ```json
   "@microsoft/agents-a365-notifications": "file:../../microsoft-agents-a365-notifications-2025.10.10.tgz",
   "@microsoft/agents-a365-observability": "file:../../microsoft-agents-a365-observability-2025.10.10.tgz",
   "@microsoft/agents-a365-tooling": "file:../../microsoft-agents-a365-tooling-2025.10.10.tgz",
   "@microsoft/agents-a365-runtime": "file:../../microsoft-agents-a365-runtime-2025.10.10.tgz",
   ```

3. **Clean install:**
   ```powershell
   cd c:\365\Agent365\nodejs\samples\perplexity-ai-sdk
   rm -Recurse -Force node_modules, package-lock.json
   npm install
   ```

**Prevention:**
When the SDK version changes (e.g., from `2025.10.10` to a newer version), remember to:
1. Rebuild the SDK packages: `npm run build:all` in `nodejs/src`
2. Update the version numbers in the `file:` paths in `package.json`
3. Reinstall dependencies

---

## TypeScript Build Issues

### Error: Module Resolution Errors

**Symptom:**
TypeScript can't find imported modules or types.

**Solution:**
1. Ensure all dependencies are installed:
   ```powershell
   npm install
   ```

2. Clean and rebuild:
   ```powershell
   npm run clean
   npm run build
   ```

3. Check that `tsconfig.json` has correct settings:
   - `moduleResolution: "NodeNext"`
   - `module: "NodeNext"`
   - `rootDir: "src"`
   - `outDir: "dist"`

---

## Runtime Issues

### Error: Missing PERPLEXITY_API_KEY

**Symptom:**
```
Missing PERPLEXITY_API_KEY environment variable.
Set it with: setx PERPLEXITY_API_KEY "your_key" (then open a new PowerShell)
```

**Solution:**
1. Get your API key from https://perplexity.ai/account/api

2. Set the environment variable (choose one):
   
   **Option A: .env file (recommended for development)**
   ```powershell
   # Copy example and edit
   cp .env.example .env
   # Edit .env and add your key
   ```
   
   **Option B: PowerShell session variable (temporary)**
   ```powershell
   $env:PERPLEXITY_API_KEY="your_api_key_here"
   ```
   
   **Option C: Persistent Windows environment variable**
   ```powershell
   setx PERPLEXITY_API_KEY "your_api_key_here"
   # Then restart PowerShell
   ```

---

## Development Workflow Issues

### Changes Not Reflected After Editing Source

**Symptom:**
You edit `.ts` files but running the app shows old behavior.

**Solution:**
Either rebuild, or use dev mode:

**Option 1: Rebuild**
```powershell
npm run build
npm run completion
```

**Option 2: Dev mode (no build needed)**
```powershell
npm run completion:dev -- "your query here"
```

---

## Common Questions

### Q: Why use local `.tgz` files instead of npm packages?

**A:** The Microsoft Agent365 SDK is currently in development and not published to the public npm registry. The local `.tgz` approach allows:
- Development and testing of SDK changes locally
- Version control of specific SDK builds
- No dependency on external package registries

### Q: How do I update to a newer SDK version?

**A:** 
1. Pull latest changes from the repository
2. Rebuild SDK: `cd nodejs/src && npm run build:all`
3. Update version numbers in sample's `package.json`
4. Reinstall: `npm install`

### Q: Can I use the `*` wildcard for local packages?

**A:** No, npm's `*` wildcard only works with packages published to a registry. For local packages, you must use explicit `file:` paths.

---

## Still Having Issues?

If none of these solutions work:

1. **Check Node.js version:**
   ```powershell
   node --version  # Should be 18.0.0 or higher
   ```

2. **Verify SDK packages exist:**
   ```powershell
   ls c:\365\Agent365\nodejs\*.tgz
   ```

3. **Check for conflicting global packages:**
   ```powershell
   npm list -g --depth=0
   ```

4. **Review the full error log:**
   Look in `C:\Users\<username>\AppData\Local\npm-cache\_logs\` for detailed error information.

5. **Try a complete clean install:**
   ```powershell
   # Clean sample
   cd c:\365\Agent365\nodejs\samples\perplexity-ai-sdk
   rm -Recurse -Force node_modules, package-lock.json, dist
   
   # Rebuild SDK
   cd ..\..\src
   npm run clean:all
   npm install
   npm run build:all
   
   # Reinstall sample
   cd ..\samples\perplexity-ai-sdk
   npm install
   npm run build
   ```

---

## Additional Resources

- [Node.js Samples README](../../README.md)
- [Agent365 SDK Documentation](../../src/README.md)
- [Perplexity AI Documentation](https://docs.perplexity.ai/)
