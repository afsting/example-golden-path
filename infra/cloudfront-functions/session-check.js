import cf from 'cloudfront';
import crypto from 'crypto';

/**
 * Viewer-request function on the site's default CloudFront behavior.
 *
 * Gates every request behind a signed session cookie, except /login.html
 * itself (which must stay reachable so an unauthenticated visitor can log
 * in at all). Fails closed: any error verifying the session redirects to
 * the login page rather than passing the request through.
 *
 * The session token format (base64url(payload).base64url(HMAC-SHA256
 * signature)) and the HMAC secret (read from the associated CloudFront
 * KeyValueStore) must stay in sync with infra/lambda/common/session.ts,
 * which issues these tokens after a successful OTP verification.
 */
async function handler(event) {
    var request = event.request;
    var uri = request.uri;

    if (uri === '/login.html') {
        return request;
    }

    var cookies = request.cookies || {};
    var sessionCookie = cookies.session;
    var token = sessionCookie && sessionCookie.value;

    if (token && (await isValidSession(token))) {
        return request;
    }

    return {
        statusCode: 302,
        statusDescription: 'Found',
        headers: {
            location: { value: '/login.html' },
            'cache-control': { value: 'no-store' },
        },
    };
}

async function isValidSession(token) {
    var parts = token.split('.');
    if (parts.length !== 2) {
        return false;
    }

    var payloadB64 = parts[0];
    var signature = parts[1];

    var secretHex;
    try {
        var kvsHandle = cf.kvs();
        secretHex = await kvsHandle.get('hmacSecret');
    } catch (e) {
        return false;
    }

    if (!secretHex) {
        return false;
    }

    var key = Buffer.from(secretHex, 'hex');
    var expected = crypto.createHmac('sha256', key).update(payloadB64).digest('base64url');

    if (expected.length !== signature.length || expected !== signature) {
        return false;
    }

    var payload;
    try {
        payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    } catch (e) {
        return false;
    }

    var nowSeconds = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp < nowSeconds) {
        return false;
    }

    return true;
}
