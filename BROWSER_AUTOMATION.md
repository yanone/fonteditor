# Browser Automation for Font Editor Testing

This guide explains how to programmatically control and test the Context font editor using Chrome DevTools Protocol (CDP).

## Prerequisites

1. **Python packages:**
   ```bash
   pip install websocket-client
   ```

2. **Test font:** Use `Fustat.babelfont.json` (3.5MB) - it's small enough to upload via CDP
   - Location: `/Users/yanone/Code/[context]/context-font-editor/test-compiler/Fustat.babelfont.json`
   - **Don't use Sukoon.babelfont** - it's 88MB with 5,838 files, too large for CDP

3. **Running web server:** Make sure the font editor is served on `http://localhost:8000`
   ```bash
   cd /Users/yanone/Code/[context]/context-font-editor/webapp
   python3 serve-with-cors.py
   ```

## Launching Chrome with Remote Debugging

Chrome must be launched with specific flags to enable remote control:

```bash
# Kill any existing Chrome instances first
killall "Google Chrome" 2>/dev/null

# Launch Chrome with remote debugging enabled
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --remote-allow-origins='*' \
  --user-data-dir=/tmp/chrome-debug \
  http://localhost:8000 &
```

**Important flags:**
- `--remote-debugging-port=9222`: Opens WebSocket on port 9222
- `--remote-allow-origins='*'`: Allows WebSocket connections from any origin
- `--user-data-dir=/tmp/chrome-debug`: Uses temporary profile (prevents conflicts)

## Basic Python Script for Browser Control

```python
import json
import urllib.request
import websocket

# Connect to Chrome
response = urllib.request.urlopen('http://localhost:9222/json')
tabs = json.loads(response.read().decode('utf-8'))
target_tab = [t for t in tabs if t.get('type') == 'page'][0]

ws = websocket.create_connection(target_tab['webSocketDebuggerUrl'])

msg_id = 1
def send_eval(expr, await_promise=False):
    global msg_id
    my_id = msg_id
    msg_id += 1
    params = {"expression": expr, "returnByValue": True}
    if await_promise:
        params["awaitPromise"] = True
    ws.send(json.dumps({"id": my_id, "method": "Runtime.evaluate", "params": params}))
    
    # Keep reading until we get our response (ignores console logs)
    while True:
        resp = json.loads(ws.recv())
        if resp.get('id') == my_id:
            return resp

# Example: Enable runtime
send_eval("1")

# Your test code here
# ...

ws.close()
```

## Common Test Operations

### 1. Type a Prompt in the Assistant

```python
result = send_eval("""
    const textarea = document.querySelector('textarea');
    textarea.value = 'Create a new glyph called test';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    
    const sendBtn = Array.from(document.querySelectorAll('button'))
        .find(b => b.textContent.toLowerCase().trim() === 'send');
    sendBtn.click();
    'Prompt sent successfully';
""")
```

### 2. Upload a Font File

```python
import json

# Read the test font
with open('/Users/yanone/Code/[context]/context-font-editor/test-compiler/Fustat.babelfont.json', 'r') as f:
    font_content = f.read()

result = send_eval(f"""
    (async function() {{
        const content = {json.dumps(font_content)};
        const fileName = 'Fustat.babelfont.json';
        
        const blob = new Blob([content], {{ type: 'application/json' }});
        const file = new File([blob], fileName, {{ type: 'application/json' }});
        
        if (typeof openFont === 'function') {{
            await openFont(file);
            return {{ success: true, fileName: fileName }};
        }}
        return {{ success: false, error: 'openFont function not found' }};
    }})();
""", await_promise=True)
```

### 3. Check Loaded Fonts

```python
result = send_eval("""
    const dropdown = document.querySelector('#open-fonts-dropdown');
    const options = Array.from(dropdown?.options || []);
    JSON.stringify({
        count: options.length,
        fonts: options.map(o => o.textContent),
        selected: dropdown?.selectedOptions[0]?.textContent
    });
""")

fonts_info = json.loads(result['result']['result']['value'])
print(f"Loaded fonts: {fonts_info['fonts']}")
```

### 4. Inspect DOM Elements

```python
# Count canvas elements
result = send_eval("document.querySelectorAll('canvas').length")
canvas_count = result['result']['result']['value']

# Get button labels
result = send_eval("""
    Array.from(document.querySelectorAll('button'))
        .map(b => b.textContent.trim())
        .filter(t => t)
        .join(', ')
""")
buttons = result['result']['result']['value']
```

### 5. Click Buttons

```python
# Click the compile button
result = send_eval("""
    const compileBtn = document.querySelector('#compile-font-btn');
    if (compileBtn && !compileBtn.disabled) {
        compileBtn.click();
        'Clicked compile button';
    } else {
        'Compile button not available';
    }
""")
```

## Limitations

### File Size Limits
The WebSocket connection has a ~100MB buffer limit. Files larger than this will cause connection resets.

**Safe for upload:**
- ✅ `Fustat.babelfont.json` (3.5MB)
- ✅ Single JSON files < 50MB

**Too large for CDP:**
- ❌ `Sukoon.babelfont` (88MB folder with 5,838 files)
- ❌ Any folder-based font with many files

### What the AI Assistant Can Do
- ✅ Execute arbitrary JavaScript in the browser
- ✅ Inspect DOM elements and their properties
- ✅ Click buttons and trigger events
- ✅ Type text into inputs/textareas
- ✅ Upload small-to-medium sized files
- ✅ Monitor network requests (with Network domain enabled)
- ✅ Take screenshots
- ✅ Read computed styles and element positions

### What the AI Assistant Cannot Do
- ❌ Interact with native file picker dialogs
- ❌ Upload very large files (>100MB)
- ❌ Upload folder-based fonts with thousands of files
- ❌ Bypass CORS restrictions
- ❌ Access files outside the browser's security context

## Recommended Test Font

**Use Fustat.babelfont.json for automated tests:**
- Size: 3.5MB (safe for CDP)
- Format: Single JSON file (easy to upload)
- Location: `/Users/yanone/Code/[context]/context-font-editor/test-compiler/Fustat.babelfont.json`

## Full Example Test Script

```python
#!/usr/bin/env python3
"""
Example: Automated test of font editor
"""
import json
import urllib.request
import websocket
import time

# 1. Connect to Chrome
response = urllib.request.urlopen('http://localhost:9222/json')
tabs = json.loads(response.read().decode('utf-8'))
target_tab = [t for t in tabs if t.get('type') == 'page'][0]
ws = websocket.create_connection(target_tab['webSocketDebuggerUrl'])

msg_id = 1
def send_eval(expr, await_promise=False):
    global msg_id
    my_id = msg_id
    msg_id += 1
    params = {"expression": expr, "returnByValue": True}
    if await_promise:
        params["awaitPromise"] = True
    ws.send(json.dumps({"id": my_id, "method": "Runtime.evaluate", "params": params}))
    while True:
        resp = json.loads(ws.recv())
        if resp.get('id') == my_id:
            return resp

send_eval("1")  # Initialize

# 2. Load test font
print("Loading Fustat font...")
with open('/Users/yanone/Code/[context]/context-font-editor/test-compiler/Fustat.babelfont.json', 'r') as f:
    font_content = f.read()

result = send_eval(f"""
    (async function() {{
        const content = {json.dumps(font_content)};
        const blob = new Blob([content], {{ type: 'application/json' }});
        const file = new File([blob], 'Fustat.babelfont.json', {{ type: 'application/json' }});
        await openFont(file);
        return 'Font loaded';
    }})();
""", await_promise=True)

time.sleep(3)

# 3. Type a prompt
print("Sending prompt to assistant...")
send_eval("""
    const textarea = document.querySelector('textarea');
    textarea.value = 'Add a test glyph';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    const sendBtn = Array.from(document.querySelectorAll('button'))
        .find(b => b.textContent.toLowerCase().includes('send'));
    sendBtn?.click();
    'Prompt sent';
""")

print("Test complete!")
ws.close()
```

## Notes for AI Assistants

When asked to test the font editor:
1. Always use `Fustat.babelfont.json` as the test font
2. Launch Chrome with the remote debugging flags first
3. Use the CDP WebSocket connection (not Selenium WebDriver)
4. Handle console messages by filtering for the response ID
5. Use `await_promise=True` for async operations
6. Remember the 100MB WebSocket buffer limit
