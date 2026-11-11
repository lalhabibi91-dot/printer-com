import base64, hashlib, hmac, secrets, time
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired
from passlib.context import CryptContext

_pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")

def hash_password(password):
    if len(password) < 6: raise ValueError("Password must be at least 6 characters")
    return _pwd.hash(password)

def verify_password(password, encoded):
    try: return _pwd.verify(password, encoded)
    except Exception: return False

def make_session(user, secret):
    s=URLSafeTimedSerializer(secret, salt="printer-session")
    return s.dumps({"username":user["username"], "role":user.get("role","customer")})

def read_session(token, secret, max_age=60*60*24*14):
    if not token: return None
    try: return URLSafeTimedSerializer(secret, salt="printer-session").loads(token, max_age=max_age)
    except (BadSignature, SignatureExpired): return None
