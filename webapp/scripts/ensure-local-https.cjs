const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const certificateDirectory = path.join(__dirname, '..', '.local-certs');
const certificatePath = path.join(certificateDirectory, 'localhost.pem');
const keyPath = path.join(certificateDirectory, 'localhost-key.pem');

if (fs.existsSync(certificatePath) && fs.existsSync(keyPath)) {
    process.exit(0);
}

fs.mkdirSync(certificateDirectory, { recursive: true });

try {
    execFileSync('mkcert', ['-install'], { stdio: 'inherit' });
    execFileSync(
        'mkcert',
        [
            '-cert-file',
            certificatePath,
            '-key-file',
            keyPath,
            'localhost',
            '127.0.0.1',
            '::1'
        ],
        { stdio: 'inherit' }
    );
} catch (error) {
    console.error(
        'Unable to provision a trusted local HTTPS certificate. Install mkcert and rerun npm run dev.'
    );
    process.exit(error.status || 1);
}
