# Cloudflare Worker Setup for GitHub Pages

Since GitHub Pages doesn't support backend servers, you need to deploy a Cloudflare Worker to proxy Anthropic API requests.

## Quick Setup (5 minutes)

### 1. Create Cloudflare Account
1. Go to https://workers.cloudflare.com/
2. Sign up for a free account (no credit card required)
3. Verify your email

### 2. Create a New Worker
1. Click "Create a Worker"
2. Replace the default code with the contents of `cloudflare-worker.js`
3. Click "Save and Deploy"

### 3. Get Your Worker URL
After deployment, you'll see your worker URL:
```
https://your-worker-name.your-subdomain.workers.dev
```

### 4. Update the App
Edit `webapp/js/ai-assistant.js`, find the `getProxyUrl()` method (around line 25) and replace:
```javascript
return 'https://your-worker-name.your-subdomain.workers.dev';
```
with your actual worker URL.

### 5. Deploy to GitHub Pages
Commit and push your changes:
```bash
git add .
git commit -m "Add Cloudflare Worker proxy URL"
git push origin main
```

GitHub Actions will automatically deploy to GitHub Pages.

## Testing

### Local Development
Just run the web server - the Cloudflare Worker is used automatically:
```bash
cd webapp
python3 serve-with-cors.py
```

### Production (GitHub Pages)
Same Cloudflare Worker URL is used - no configuration needed!

## Benefits of This Approach

1. **Single Configuration**: Same proxy URL for local development and production
2. **No Local Server**: You don't need to run `anthropic-proxy.py` anymore
3. **Always Available**: Works from anywhere with internet access
4. **Free Tier**: Cloudflare free tier includes 100,000 requests/day

## Security Notes

1. **API Key**: Your Anthropic API key is still stored client-side and sent through the worker
2. **Worker Security**: The worker only proxies to Anthropic API, not other endpoints
3. **Rate Limiting**: Consider adding rate limiting to your worker if needed
4. **HTTPS Only**: The worker uses HTTPS, which is more secure than the local HTTP proxy

## Alternative: Vercel/Netlify Functions

If you prefer Vercel or Netlify, you can create a serverless function instead:

### Vercel Function (`/api/anthropic.js`):
```javascript
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, anthropic-version');
    return res.status(200).end();
  }

  const apiKey = req.headers['x-api-key'];
  if (!apiKey) {
    return res.status(401).json({ error: 'API key required' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(response.status).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
```

Then update the proxy URL to: `https://your-app.vercel.app/api/anthropic`

## Troubleshooting

### "Worker not found"
- Make sure worker is deployed (status should be "Active")
- Check the URL matches exactly

### "API key required"
- Enter your Anthropic API key in the app's input field
- The key should start with `sk-ant-`

### "CORS error"
- Make sure the worker code includes all CORS headers
- Clear browser cache and reload

### "Network error"
- Check if the worker URL is correct
- Try accessing the worker URL directly (should return "Method not allowed")
