import os, asyncio
from datetime import datetime, timezone, timedelta
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, Response, HTTPException, Depends
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from pydantic import BaseModel
from dotenv import load_dotenv
from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes
from json_store import JsonUserStore
from security import hash_password, verify_password, make_session, read_session

load_dotenv()
BOT_TOKEN=os.getenv("BOT_TOKEN","")
ADMINS={int(x.strip()) for x in os.getenv("ADMIN_TELEGRAM_IDS","").split(",") if x.strip()}
SECRET=os.getenv("SESSION_SECRET","")
COOKIE_SECURE=os.getenv("COOKIE_SECURE","true").lower()=="true"
store=None
bot_app=None

def now_iso(): return datetime.now(timezone.utc).isoformat()
def expiry_from(body):
    mins=int(body.get("days",0))*1440+int(body.get("hours",0))*60+int(body.get("minutes",0))
    return (datetime.now(timezone.utc)+timedelta(minutes=mins)).isoformat() if mins else None
def expired(user):
    e=user.get("expiresAt")
    return bool(e and datetime.fromisoformat(e.replace("Z","+00:00")) <= datetime.now(timezone.utc))
def public_user(u):
    return {k:u.get(k) for k in ["id","username","role","isActive","expiresAt","note","lastSeen","tiktokUsername"]} | {"expired":expired(u)}

async def resolve_username(identifier):
    for item in await store.list_users():
        if str(item.get("id")) == str(identifier) or item.get("username", "").lower() == str(identifier).lower():
            return item.get("username")
    return None

def current_user(request: Request):
    data=read_session(request.cookies.get("printer_session"),SECRET)
    if not data: raise HTTPException(401,"Please log in")
    return data

async def require_user(request: Request):
    data=current_user(request)
    u=await store.get_user(data["username"])
    if not u or not u.get("isActive",True) or expired(u):
        raise HTTPException(401,"Account inactive or expired")
    return u

async def require_admin(u=Depends(require_user)):
    if u.get("role")!="admin": raise HTTPException(403,"Admin only")
    return u

class Login(BaseModel):
    username:str
    password:str

@asynccontextmanager
async def lifespan(app):
    global store, bot_app
    required=[BOT_TOKEN,SECRET]
    if not all(required): raise RuntimeError("Missing BOT_TOKEN or SESSION_SECRET environment variable.")
    if not ADMINS: raise RuntimeError("Set ADMIN_TELEGRAM_IDS to your numeric Telegram user ID.")
    store=JsonUserStore(os.getenv("DATA_FILE", "/var/data/users.json"))
    # Ensure initial website administrator exists.
    uname=os.getenv("INITIAL_ADMIN_USERNAME","admin")
    if not await store.get_user(uname):
        await store.create_user({"username":uname,"passwordHash":hash_password(os.getenv("INITIAL_ADMIN_PASSWORD","change_this_immediately")),"role":"admin","isActive":True,"expiresAt":None,"note":"Initial admin","createdAt":now_iso(),"lastSeen":None})
    bot_app=Application.builder().token(BOT_TOKEN).build()
    bot_app.add_handler(CommandHandler("start", cmd_start))
    bot_app.add_handler(CommandHandler("help", cmd_help))
    bot_app.add_handler(CommandHandler("adduser", cmd_adduser))
    bot_app.add_handler(CommandHandler("users", cmd_users))
    bot_app.add_handler(CommandHandler("delete", cmd_delete))
    bot_app.add_handler(CommandHandler("disable", cmd_disable))
    bot_app.add_handler(CommandHandler("enable", cmd_enable))
    bot_app.add_handler(CommandHandler("resetpass", cmd_resetpass))
    await bot_app.initialize(); await bot_app.start()
    await bot_app.updater.start_polling(drop_pending_updates=True)
    yield
    await bot_app.updater.stop(); await bot_app.stop(); await bot_app.shutdown()

app=FastAPI(title="Printer Telegram Account API", lifespan=lifespan)

@app.get("/api/auth/status")
async def auth_status(request: Request):
    try:
        u=await require_user(request)
        await store.update_user(u["username"],{"lastSeen":now_iso()})
        return {"authenticated":True,"user":public_user(u)}
    except HTTPException: return {"authenticated":False}

@app.post("/api/auth/login")
async def login(data: Login, response: Response):
    u=await store.get_user(data.username.strip())
    if not u or not verify_password(data.password,u.get("passwordHash","")):
        raise HTTPException(401,"Invalid username or password")
    if not u.get("isActive",True): raise HTTPException(403,"Account disabled")
    if expired(u): raise HTTPException(403,"Account expired")
    await store.update_user(u["username"],{"lastSeen":now_iso()})
    response.set_cookie("printer_session",make_session(u,SECRET),httponly=True,samesite="lax",secure=COOKIE_SECURE,max_age=1209600)
    return {"success":True,"user":public_user(u)}

@app.post("/api/auth/logout")
async def logout(response: Response):
    response.delete_cookie("printer_session")
    return {"success":True}

@app.get("/api/users")
async def users(admin=Depends(require_admin)):
    return {"users":[public_user(u) for u in await store.list_users()]}

@app.post("/api/users")
async def create_user(request: Request, admin=Depends(require_admin)):
    b=await request.json()
    username=str(b.get("username","")).strip()
    if not username or len(username)>64: raise HTTPException(400,"Enter a valid username")
    try: pw=hash_password(str(b.get("password","")))
    except ValueError as e: raise HTTPException(400,str(e))
    u={"username":username,"passwordHash":pw,"role":b.get("role","customer") if b.get("role") in ["admin","customer"] else "customer","isActive":True,"expiresAt":expiry_from(b),"note":str(b.get("note",""))[:250],"createdAt":now_iso(),"lastSeen":None}
    try: await store.create_user(u)
    except ValueError as e: raise HTTPException(409,str(e))
    return {"success":True}

@app.patch("/api/users/{username}")
async def patch_user(username: str, request: Request, admin=Depends(require_admin)):
    username = await resolve_username(username)
    if not username: raise HTTPException(404,"User not found")
    b=await request.json(); changes={}
    if "password" in b:
        try: changes["passwordHash"]=hash_password(str(b["password"]))
        except ValueError as e: raise HTTPException(400,str(e))
    if "isActive" in b: changes["isActive"]=bool(b["isActive"])
    if b.get("noExpiry"): changes["expiresAt"]=None
    if "addMinutes" in b:
        u=await store.get_user(username)
        current=datetime.fromisoformat(u["expiresAt"]) if u and u.get("expiresAt") else datetime.now(timezone.utc)
        changes["expiresAt"]=(current+timedelta(minutes=int(b["addMinutes"]))).isoformat()
    try: await store.update_user(username,changes)
    except ValueError as e: raise HTTPException(404,str(e))
    return {"success":True}

@app.delete("/api/users/{username}")
async def delete_user(username: str, admin=Depends(require_admin)):
    username = await resolve_username(username)
    if not username: raise HTTPException(404,"User not found")
    if username.lower()==admin["username"].lower(): raise HTTPException(400,"Cannot delete your own admin account")
    try: await store.delete_user(username)
    except ValueError as e: raise HTTPException(404,str(e))
    return {"success":True}

# Telegram bot management
async def allowed(update):
    return bool(update.effective_user and update.effective_user.id in ADMINS)
async def reply(update,text):
    await update.effective_message.reply_text(text)
async def cmd_start(update,ctx):
    if await allowed(update): await reply(update,"Printer account manager is ready. Send /help for commands.")
    else: await reply(update,"Not authorized.")
async def cmd_help(update,ctx):
    if await allowed(update): await reply(update,"Commands:\n/adduser username password days\n/users\n/delete username\n/disable username\n/enable username\n/resetpass username newpassword\nUse days=0 for no expiry.")
    else: await reply(update,"Not authorized.")
async def cmd_adduser(update,ctx):
    if not await allowed(update): return await reply(update,"Not authorized.")
    if len(ctx.args)<3: return await reply(update,"Usage: /adduser username password days")
    name,pw,days=ctx.args[:3]
    try:
        user={"username":name,"passwordHash":hash_password(pw),"role":"customer","isActive":True,"expiresAt":(datetime.now(timezone.utc)+timedelta(days=int(days))).isoformat() if int(days)>0 else None,"note":"Created via Telegram","createdAt":now_iso(),"lastSeen":None}
        await store.create_user(user); await reply(update,f"Created {name}.")
    except Exception as e: await reply(update,f"Error: {e}")
async def cmd_users(update,ctx):
    if not await allowed(update): return await reply(update,"Not authorized.")
    us=await store.list_users()
    lines=[f"{u['username']} | {'active' if u.get('isActive') else 'disabled'} | {u.get('expiresAt') or 'never'}" for u in us]
    await reply(update,"\n".join(lines[:80]) or "No users.")
async def cmd_delete(update,ctx):
    if not await allowed(update): return await reply(update,"Not authorized.")
    if not ctx.args: return await reply(update,"Usage: /delete username")
    try: await store.delete_user(ctx.args[0]); await reply(update,"Deleted.")
    except Exception as e: await reply(update,f"Error: {e}")
async def set_active(update,ctx,value):
    if not await allowed(update): return await reply(update,"Not authorized.")
    if not ctx.args: return await reply(update,"Usage: /enable username")
    try: await store.update_user(ctx.args[0],{"isActive":value}); await reply(update,"Updated.")
    except Exception as e: await reply(update,f"Error: {e}")
async def cmd_disable(update,ctx): await set_active(update,ctx,False)
async def cmd_enable(update,ctx): await set_active(update,ctx,True)
async def cmd_resetpass(update,ctx):
    if not await allowed(update): return await reply(update,"Not authorized.")
    if len(ctx.args)<2: return await reply(update,"Usage: /resetpass username newpassword")
    try: await store.update_user(ctx.args[0],{"passwordHash":hash_password(ctx.args[1])}); await reply(update,"Password reset.")
    except Exception as e: await reply(update,f"Error: {e}")


@app.get("/health")
async def health():
    return {"ok": True}

# Serve the website files from the same Render service. Keep this mount last
# so /api routes above take precedence.
FRONTEND_DIR = Path(__file__).resolve().parent.parent
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
