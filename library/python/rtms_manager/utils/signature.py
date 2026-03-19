import hmac
import hashlib


def generate_rtms_signature(rtms_id: str, stream_id: str, client_id: str, client_secret: str) -> str:
    message = f"{client_id},{rtms_id},{stream_id}"
    signature = hmac.new(
        client_secret.encode('utf-8'),
        message.encode('utf-8'),
        hashlib.sha256
    ).hexdigest()
    return signature
