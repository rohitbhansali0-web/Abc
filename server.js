import express from "express";
import pg from "pg";
import crypto from "crypto";
import QRCode from "qrcode";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pg;
const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined });

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public")));

const sessions = new Map();
const otpMemory = new Map();

const TEMPLES = [
  { id:"t1", name:"Sri Venkateshwara Temple", city:"Tirupati", price:300, slots:["Morning Darshan · 6:00–8:00 AM","Afternoon Darshan · 12:00–2:00 PM","Evening Aarti · 6:00–8:00 PM"] },
  { id:"t2", name:"Meenakshi Amman Temple", city:"Madurai", price:150, slots:["Morning Darshan · 7:00–9:00 AM","Evening Aarti · 5:30–7:30 PM"] },
  { id:"t3", name:"Kashi Vishwanath Mandir", city:"Varanasi", price:200, slots:["Mangala Aarti · 3:00–4:00 AM","Morning Darshan · 8:00–10:00 AM","Sandhya Aarti · 7:00–8:00 PM"] },
  { id:"t4", name:"Shirdi Sai Baba Sansthan", city:"Shirdi", price:100, slots:["Kakad Aarti · 5:00–6:00 AM","Afternoon Darshan · 1:00–3:00 PM"] }
];

function token(){
  return crypto.randomBytes(32).toString("hex");
}
function signPass(b){
  const payload = `${b.id}|${b.phone}|${b.temple_id}|${b.date}|${b.slot}`;
  const secret = process.env.SESSION_SECRET || "CHANGE_ME";
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `SETU1.${Buffer.from(payload).toString("base64url")}.${sig}`;
}
function parsePass(raw){
  try {
    const [prefix, encoded, sig] = String(raw).split(".");
    if(prefix !== "SETU1" || !encoded || !sig) return null;
    const payload = Buffer.from(encoded, "base64url").toString();
    const expected = crypto.createHmac("sha256", process.env.SESSION_SECRET || "CHANGE_ME").update(payload).digest("hex");
    if(!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const [id, phone, temple_id, date, slot] = payload.split("|");
    return {id, phone, temple_id, date, slot};
  } catch { return null; }
}
function setSession(role, extra={}){
  const sid = token();
  sessions.set(sid, { role, ...extra, createdAt:Date.now() });
  return sid;
}
function getSession(req){
  const sid = req.headers["x-setu-session"];
  return sid ? sessions.get(sid) : null;
}
function requireRole(role){
  return (req,res,next)=>{
    const s = getSession(req);
    if(!s || s.role !== role) return res.status(403).json({error:"Forbidden"});
    next();
  };
}
function cleanPhone(p){
  const d = String(p||"").replace(/\D/g,"");
  return d.length===10 ? "+91"+d : (d.startsWith("+") ? d : "+"+d);
}
function nextDates(n=5){
  const out=[]; const d=new Date();
  for(let i=1;i<=n;i++){const x=new Date(d);x.setDate(d.getDate()+i);out.push(x.toISOString().slice(0,10));}
  return out;
}

async function initDb(){
  if(!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS devotees(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      phone TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS bookings(
      id TEXT PRIMARY KEY,
      devotee_id UUID REFERENCES devotees(id),
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      temple_id TEXT NOT NULL,
      temple TEXT NOT NULL,
      city TEXT NOT NULL,
      date DATE NOT NULL,
      slot TEXT NOT NULL,
      qty INT NOT NULL DEFAULT 1,
      unit_price INT NOT NULL,
      total INT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',
      paid_at TIMESTAMPTZ,
      used_at TIMESTAMPTZ,
      pass_token TEXT,
      whatsapp_sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS scans(
      id BIGSERIAL PRIMARY KEY,
      booking_id TEXT NOT NULL,
      gate_user TEXT,
      ok BOOLEAN NOT NULL,
      reason TEXT NOT NULL,
      scanned_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}

async function twilioVerifyStart(phone){
  if(process.env.DEMO_OTP === "true") {
    otpMemory.set(phone,{code:"123456",expires:Date.now()+5*60*1000});
    return;
  }
  const sid=process.env.TWILIO_ACCOUNT_SID, auth=process.env.TWILIO_AUTH_TOKEN, service=process.env.TWILIO_VERIFY_SERVICE_SID;
  if(!sid||!auth||!service) throw new Error("Twilio OTP is not configured");
  const body=new URLSearchParams({To:phone,Channel:"sms"});
  const r=await fetch(`https://verify.twilio.com/v2/Services/${service}/Verifications`,{
    method:"POST",headers:{Authorization:"Basic "+Buffer.from(`${sid}:${auth}`).toString("base64"),"Content-Type":"application/x-www-form-urlencoded"},body
  });
  if(!r.ok) throw new Error("OTP provider rejected request");
}
async function twilioVerifyCheck(phone,code){
  if(process.env.DEMO_OTP === "true"){
    const x=otpMemory.get(phone);
    if(x && x.code===code && x.expires>Date.now()){otpMemory.delete(phone);return true;}
    return false;
  }
  const sid=process.env.TWILIO_ACCOUNT_SID, auth=process.env.TWILIO_AUTH_TOKEN, service=process.env.TWILIO_VERIFY_SERVICE_SID;
  if(!sid||!auth||!service) return false;
  const body=new URLSearchParams({To:phone,Code:code});
  const r=await fetch(`https://verify.twilio.com/v2/Services/${service}/VerificationCheck`,{
    method:"POST",headers:{Authorization:"Basic "+Buffer.from(`${sid}:${auth}`).toString("base64"),"Content-Type":"application/x-www-form-urlencoded"},body
  });
  if(!r.ok) return false;
  const j=await r.json();
  return j.status==="approved";
}

async function sendWhatsApp(b){
  const tokenW=process.env.WHATSAPP_TOKEN, phoneId=process.env.WHATSAPP_PHONE_NUMBER_ID, template=process.env.WHATSAPP_TEMPLATE_NAME;
  if(!tokenW||!phoneId||!template) return {sent:false,reason:"WhatsApp not configured"};
  const lang=process.env.WHATSAPP_TEMPLATE_LANGUAGE||"en_US";
  const url=`https://graph.facebook.com/v23.0/${phoneId}/messages`;
  const payload={
    messaging_product:"whatsapp",to:b.phone.replace("+",""),type:"template",
    template:{name:template,language:{code:lang},components:[{type:"body",parameters:[
      {type:"text",text:b.name},{type:"text",text:b.temple},{type:"text",text:String(b.date)},{type:"text",text:b.slot},{type:"text",text:b.id}
    ]}]}
  };
  const r=await fetch(url,{method:"POST",headers:{"Authorization":`Bearer ${tokenW}`,"Content-Type":"application/json"},body:JSON.stringify(payload)});
  const j=await r.json();
  if(!r.ok) throw new Error(j?.error?.message||"WhatsApp API error");
  return {sent:true};
}

app.get("/api/health",(req,res)=>res.json({ok:true,service:"setu"}));
app.get("/api/temples",(req,res)=>res.json({temples:TEMPLES,dates:nextDates()}));

app.post("/api/devotee/otp/start",async(req,res)=>{
  try{
    const phone=cleanPhone(req.body.phone);
    const name=String(req.body.name||"").trim();
    if(!/^\+91\d{10}$/.test(phone)||name.length<2) return res.status(400).json({error:"Enter valid name and Indian mobile number"});
    await twilioVerifyStart(phone);
    res.json({ok:true,phone});
  }catch(e){res.status(400).json({error:e.message});}
});

app.post("/api/devotee/otp/verify",async(req,res)=>{
  try{
    const phone=cleanPhone(req.body.phone), name=String(req.body.name||"").trim(), code=String(req.body.code||"").trim();
    const ok=await twilioVerifyCheck(phone,code);
    if(!ok) return res.status(401).json({error:"Invalid or expired OTP"});
    const r=await pool.query(`INSERT INTO devotees(phone,name) VALUES($1,$2) ON CONFLICT(phone) DO UPDATE SET name=EXCLUDED.name RETURNING id,phone,name`,[phone,name]);
    const sid=setSession("devotee",{devoteeId:r.rows[0].id,phone,name});
    res.json({ok:true,session:sid,devotee:r.rows[0]});
  }catch(e){res.status(400).json({error:e.message});}
});

app.post("/api/devotee/bookings",requireRole("devotee"),async(req,res)=>{
  try{
    const s=getSession(req), {templeId,date,slot,qty}=req.body;
    const t=TEMPLES.find(x=>x.id===templeId); const q=Math.max(1,Math.min(10,Number(qty)||1));
    if(!t||!t.slots.includes(slot)||!nextDates(30).includes(date)) return res.status(400).json({error:"Invalid temple, slot or date"});
    const id="STU-"+crypto.randomBytes(4).toString("hex").toUpperCase();
    const r=await pool.query(`INSERT INTO bookings(id,devotee_id,name,phone,temple_id,temple,city,date,slot,qty,unit_price,total) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [id,s.devoteeId,s.name,s.phone,t.id,t.name,t.city,date,slot,q,t.price,t.price*q]);
    res.json({ok:true,booking:r.rows[0]});
  }catch(e){res.status(400).json({error:e.message});}
});

app.get("/api/devotee/bookings",requireRole("devotee"),async(req,res)=>{
  const s=getSession(req);
  const r=await pool.query(`SELECT * FROM bookings WHERE devotee_id=$1 ORDER BY created_at DESC`,[s.devoteeId]);
  res.json({bookings:r.rows});
});

app.get("/api/counter/bookings",requireRole("counter"),async(req,res)=>{
  const q=String(req.query.q||"").trim();
  const r= q ? await pool.query(`SELECT * FROM bookings WHERE id ILIKE $1 OR phone ILIKE $1 ORDER BY created_at DESC LIMIT 50`,[`%${q}%`])
            : await pool.query(`SELECT * FROM bookings WHERE status='PENDING_PAYMENT' ORDER BY created_at DESC LIMIT 50`);
  res.json({bookings:r.rows});
});

app.post("/api/counter/login",(req,res)=>{
  if(req.body.username===process.env.COUNTER_USERNAME && req.body.password===process.env.COUNTER_PASSWORD)
    return res.json({ok:true,session:setSession("counter",{username:req.body.username})});
  res.status(401).json({error:"Invalid counter credentials"});
});

app.post("/api/gate/login",(req,res)=>{
  if(req.body.username===process.env.GATE_USERNAME && req.body.password===process.env.GATE_PASSWORD)
    return res.json({ok:true,session:setSession("gate",{username:req.body.username})});
  res.status(401).json({error:"Invalid gate credentials"});
});

app.post("/api/counter/pay/:id",requireRole("counter"),async(req,res)=>{
  try{
    const r=await pool.query(`SELECT * FROM bookings WHERE id=$1`,[req.params.id]);
    if(!r.rowCount) return res.status(404).json({error:"Booking not found"});
    const b=r.rows[0];
    if(b.status!=="PENDING_PAYMENT") return res.status(400).json({error:"Payment already processed"});
    const pass=signPass(b);
    const u=await pool.query(`UPDATE bookings SET status='PAID',paid_at=now(),pass_token=$2 WHERE id=$1 RETURNING *`,[b.id,pass]);
    let wa={sent:false};
    try{wa=await sendWhatsApp(u.rows[0]); if(wa.sent) await pool.query(`UPDATE bookings SET whatsapp_sent_at=now() WHERE id=$1`,[b.id]);}
    catch(e){wa={sent:false,reason:e.message};}
    res.json({ok:true,booking:u.rows[0],whatsapp:wa});
  }catch(e){res.status(400).json({error:e.message});}
});

app.get("/api/counter/pass/:id/qr",requireRole("counter"),async(req,res)=>{
  const r=await pool.query(`SELECT pass_token FROM bookings WHERE id=$1 AND status IN ('PAID','USED')`,[req.params.id]);
  if(!r.rowCount) return res.status(404).end();
  const png=await QRCode.toBuffer(r.rows[0].pass_token,{width:700,margin:2});
  res.type("png").send(png);
});

app.post("/api/gate/validate",requireRole("gate"),async(req,res)=>{
  try{
    const raw=String(req.body.payload||"");
    const p=parsePass(raw);
    if(!p){await pool.query(`INSERT INTO scans(booking_id,gate_user,ok,reason) VALUES($1,$2,false,$3)`,["UNKNOWN",getSession(req).username,"Invalid signature"]);return res.status(400).json({ok:false,reason:"Invalid QR signature"});}
    const r=await pool.query(`SELECT * FROM bookings WHERE id=$1`,[p.id]);
    if(!r.rowCount){await pool.query(`INSERT INTO scans(booking_id,gate_user,ok,reason) VALUES($1,$2,false,$3)`,[p.id,getSession(req).username,"Booking not found"]);return res.status(404).json({ok:false,reason:"Booking not found"});}
    const b=r.rows[0];
    if(b.phone!==p.phone || b.temple_id!==p.temple_id || String(b.date)!==p.date || b.slot!==p.slot) return res.status(400).json({ok:false,reason:"QR details do not match booking"});
    if(b.status==="PENDING_PAYMENT") return res.status(400).json({ok:false,reason:"Payment not confirmed; pass not issued"});
    if(b.status==="USED") return res.status(409).json({ok:false,reason:"Pass already used",booking:b});
    const u=await pool.query(`UPDATE bookings SET status='USED',used_at=now() WHERE id=$1 AND status='PAID' RETURNING *`,[b.id]);
    if(!u.rowCount) return res.status(409).json({ok:false,reason:"Pass was already used"});
    await pool.query(`INSERT INTO scans(booking_id,gate_user,ok,reason) VALUES($1,$2,true,$3)`,[b.id,getSession(req).username,"Entry granted"]);
    res.json({ok:true,reason:"Signature verified. First valid scan — entry granted.",booking:u.rows[0]});
  }catch(e){res.status(400).json({error:e.message});}
});

app.get("/counter",(req,res)=>res.sendFile(path.join(__dirname,"public","counter.html")));
app.get("/gate",(req,res)=>res.sendFile(path.join(__dirname,"public","gate.html")));
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

initDb().then(()=>app.listen(PORT,()=>console.log(`Setu listening on ${PORT}`))).catch(e=>{console.error(e);process.exit(1)});
