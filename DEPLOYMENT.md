# Deployment Guide

## GitHub Pages Deployment

This project is configured to automatically deploy to GitHub Pages when you push to the `main` branch.

### Setup Instructions

1. **Enable GitHub Pages** in your repository:
   - Go to Settings → Pages
   - Source: "GitHub Actions"

2. **Push to main branch**:
   ```bash
   git push origin main
   ```

3. **Access your app**:
   - Your app will be available at: `https://yanone.github.io/fonteditor/`

### CORS Configuration

The app requires specific CORS headers for SharedArrayBuffer (needed by Pyodide and fontc WASM):
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`

These are configured via:
- `webapp/_headers` file (for some hosting providers)
- GitHub Actions workflow automatically applies these headers

### Manual Deployment

If GitHub Actions doesn't work for your hosting provider, you can manually deploy:

1. **Build/Copy files**:
   ```bash
   # All files are in webapp/ folder
   cd webapp
   ```

2. **Upload to your hosting**:
   - Upload entire `webapp/` folder contents
   - Ensure CORS headers are set (see your hosting provider's docs)

### Testing Locally

Run the local development server with CORS headers:

```bash
cd webapp
python3 serve-with-cors.py
```

Then open: `http://localhost:8000`

### Anthropic API Proxy

For the AI Assistant to work on GitHub Pages, you'll need to either:

1. **Use the public CORS proxy** (already configured as fallback):
   - Works automatically
   - Less secure (API key passes through third party)

2. **Deploy your own proxy**:
   - Deploy `webapp/anthropic-proxy.py` to a server
   - Update the proxy URL in `js/ai-assistant.js` line 210
   - More secure for production use

### Troubleshooting

**SharedArrayBuffer not available:**
- Check browser console for COOP/COEP errors
- Ensure `_headers` file is being served
- GitHub Pages should handle this automatically

**AI Assistant CORS errors:**
- The app will automatically fall back to public proxy
- For production, deploy your own proxy server

**Files not updating:**
- Cache busting is automatic (timestamp query params)
- Force refresh: Ctrl+F5 (Windows/Linux) or Cmd+Shift+R (Mac)
