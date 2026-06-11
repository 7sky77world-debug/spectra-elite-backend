import express from "express";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import multer from "multer";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Supabase setup
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

// File upload setup (memory storage)
const upload = multer({ storage: multer.memoryStorage() });

// ---------- Helper: Verify JWT token from frontend ----------
async function getUserFromToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  const token = authHeader.split(" ")[1];
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

async function isAdmin(req) {
  const user = await getUserFromToken(req);
  if (!user) return false;
  const { data: profile } = await supabase.from("profiles").select("role_name").eq("id", user.id).single();
  return profile?.role_name === "Admin";
}

// ---------- AUTH ROUTES ----------
app.post("/auth/tenant/otp", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });
  const { error } = await supabase.auth.signInWithOtp({ email });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: "OTP sent to email" });
});

app.post("/auth/tenant/verify", async (req, res) => {
  const { email, token } = req.body;
  const { data, error } = await supabase.auth.verifyOtp({ email, token, type: "email" });
  if (error) return res.status(401).json({ error: error.message });
  res.json({ session: data.session });
});

// ---------- TENANT PORTAL API ----------
app.get("/api/tenant/booking", async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const { data: booking } = await supabase
    .from("bookings")
    .select(`*, rooms(room_number, type), properties(name, address)`)
    .eq("tenant_id", user.id)
    .single();
  if (!booking) return res.json(null);
  res.json({
    booking_id: booking.id,
    move_in: booking.move_in_date,
    move_out: booking.move_out_date,
    rent: booking.monthly_rent,
    deposit: booking.security_deposit,
    status: booking.status,
    room_number: booking.rooms.room_number,
    property_name: booking.properties.name,
  });
});

app.get("/api/tenant/invoice/:invoiceId", async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const { data: invoice } = await supabase.from("invoices").select("*").eq("id", req.params.invoiceId).eq("tenant_id", user.id).single();
  if (!invoice) return res.status(404).json({ error: "Not found" });
  res.json(invoice); // In real app you'd generate PDF, but for simplicity return JSON
});

app.post("/api/tenant/upload-id", upload.single("file"), async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const { type } = req.body;
  const file = req.file;
  const filePath = `id-proofs/${user.id}/${type}-${Date.now()}.${file.originalname.split(".").pop()}`;
  const { error } = await supabase.storage.from("tenant-docs").upload(filePath, file.buffer);
  if (error) return res.status(500).json({ error: error.message });
  const { data: publicUrl } = supabase.storage.from("tenant-docs").getPublicUrl(filePath);
  const updateColumn = type === "pan" ? "pan_url" : "aadhar_url";
  await supabase.from("profiles").update({ [updateColumn]: publicUrl.publicUrl }).eq("id", user.id);
  res.json({ url: publicUrl.publicUrl });
});

// ---------- ADMIN API (with admin check) ----------
app.get("/api/admin/analytics", async (req, res) => {
  if (!(await isAdmin(req))) return res.status(403).json({ error: "Admin only" });
  // Get current month's rent collected
  const now = new Date();
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split("T")[0];
  const { data: rentPayments } = await supabase.from("payments").select("amount").eq("type", "Rent").eq("status", "Success").gte("date", firstDay).lte("date", lastDay);
  const totalMonthlyRentCollected = rentPayments?.reduce((s, p) => s + p.amount, 0) || 0;

  const { data: deposits } = await supabase.from("bookings").select("security_deposit").eq("status", "CheckedIn");
  const totalSecurityDeposit = deposits?.reduce((s, b) => s + b.security_deposit, 0) || 0;

  const { data: arrears } = await supabase.from("invoices").select("amount").in("status", ["Unpaid", "Overdue"]);
  const totalRentArrears = arrears?.reduce((s, i) => s + i.amount, 0) || 0;

  const { data: moveOuts } = await supabase.from("bookings").select("security_deposit").eq("exit_type", "Notice Period").is("security_deposit_refunded", null);
  const totalDepositRefund = moveOuts?.reduce((s, b) => s + b.security_deposit, 0) || 0;

  const { data: expenses } = await supabase.from("expense_ledger").select("amount");
  const totalExpenses = expenses?.reduce((s, e) => s + e.amount, 0) || 0;

  // Rooms & beds (hardcoded 44 as per requirement)
  const { data: rooms } = await supabase.from("rooms").select("total_beds, available_beds");
  let totalBeds = 0, totalBookedBeds = 0;
  rooms?.forEach(r => { totalBeds += r.total_beds; totalBookedBeds += r.total_beds - r.available_beds; });
  const occupancyRate = totalBeds ? ((totalBookedBeds / totalBeds) * 100).toFixed(1) : 0;

  const { count: moveInPending } = await supabase.from("bookings").select("*", { count: "exact", head: true }).eq("status", "Confirmed");
  const { count: moveOutRaised } = await supabase.from("bookings").select("*", { count: "exact", head: true }).eq("status", "Cancelled");
  const { count: visitScheduled } = await supabase.from("leads").select("*", { count: "exact", head: true }).eq("status", "Visit Scheduled");
  const { count: openComplaints } = await supabase.from("complaints").select("*", { count: "exact", head: true }).in("status", ["Open", "Assigned", "In Progress"]);

  res.json({
    totalMonthlyRentCollected,
    totalSecurityDeposit,
    totalRentArrears,
    totalDepositRefund,
    totalExpenses,
    totalRooms: 22,
    totalBeds: 44,
    totalBookedBeds,
    totalAvailableBeds: totalBeds - totalBookedBeds,
    occupancyRate,
    moveInPending,
    moveOutRaised,
    visitScheduled,
    openComplaints,
  });
});

// GET all tenants (for admin)
app.get("/api/admin/tenants", async (req, res) => {
  if (!(await isAdmin(req))) return res.status(403).json({ error: "Admin only" });
  const { data } = await supabase.from("profiles").select("*, bookings(*, rooms(*), properties(*))");
  res.json(data);
});

// Add tenant manually
app.post("/api/admin/tenants", async (req, res) => {
  if (!(await isAdmin(req))) return res.status(403).json({ error: "Admin only" });
  const { email, password, name, phone, ...rest } = req.body;
  // Create auth user
  const { data: authUser, error: authError } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (authError) return res.status(400).json({ error: authError.message });
  const { error: profileError } = await supabase.from("profiles").insert({ id: authUser.user.id, name, email, phone, role_name: "Tenant", ...rest });
  if (profileError) return res.status(400).json({ error: profileError.message });
  res.status(201).json({ message: "Tenant created" });
});

// Update tenant
app.put("/api/admin/tenants/:id", async (req, res) => {
  if (!(await isAdmin(req))) return res.status(403).json({ error: "Admin only" });
  const { id } = req.params;
  const { error } = await supabase.from("profiles").update(req.body).eq("id", id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

// Upload agreement
app.post("/api/admin/tenants/:id/agreement", upload.single("file"), async (req, res) => {
  if (!(await isAdmin(req))) return res.status(403).json({ error: "Admin only" });
  const { id } = req.params;
  const file = req.file;
  const filePath = `agreements/${id}/${Date.now()}.pdf`;
  await supabase.storage.from("tenant-docs").upload(filePath, file.buffer);
  const { data: publicUrl } = supabase.storage.from("tenant-docs").getPublicUrl(filePath);
  await supabase.from("bookings").update({ contract_url: publicUrl.publicUrl }).eq("tenant_id", id);
  res.json({ url: publicUrl.publicUrl });
});

// Expenses
app.get("/api/admin/expenses", async (req, res) => {
  if (!(await isAdmin(req))) return res.status(403).json({ error: "Admin only" });
  const { data } = await supabase.from("expense_ledger").select("*, properties(name)");
  res.json(data);
});

app.post("/api/admin/expenses", async (req, res) => {
  if (!(await isAdmin(req))) return res.status(403).json({ error: "Admin only" });
  const user = await getUserFromToken(req);
  const { error } = await supabase.from("expense_ledger").insert({ ...req.body, created_by: user.id });
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ message: "Expense added" });
});

// Fix Repair Tickets
app.get("/api/admin/fix-repair", async (req, res) => {
  if (!(await isAdmin(req))) return res.status(403).json({ error: "Admin only" });
  const { data } = await supabase.from("fix_repair_tickets").select("*, profiles(name)");
  res.json(data);
});

app.post("/api/admin/fix-repair", async (req, res) => {
  if (!(await isAdmin(req))) return res.status(403).json({ error: "Admin only" });
  const user = await getUserFromToken(req);
  const { error } = await supabase.from("fix_repair_tickets").insert({ ...req.body, created_by: user.id });
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ message: "Ticket created" });
});

app.put("/api/admin/fix-repair/:id", async (req, res) => {
  if (!(await isAdmin(req))) return res.status(403).json({ error: "Admin only" });
  const { id } = req.params;
  await supabase.from("fix_repair_tickets").update(req.body).eq("id", id);
  res.json({ success: true });
});

// Announcements
app.post("/api/admin/announcements", async (req, res) => {
  if (!(await isAdmin(req))) return res.status(403).json({ error: "Admin only" });
  const { title, content, channel } = req.body;
  const user = await getUserFromToken(req);
  // Get all tenant emails
  const { data: tenants } = await supabase.from("profiles").select("email").eq("role_name", "Tenant");
  if (channel === "email" || channel === "both") {
    for (const t of tenants) {
      await resend.emails.send({
        from: "Spectra Elite <no-reply@spectra-elite.com>",
        to: t.email,
        subject: title,
        html: `<p>${content}</p>`,
      });
    }
  }
  if (channel === "whatsapp" || channel === "both") {
    // Log to whatsapp_logs (real integration would require Twilio)
    for (const t of tenants) {
      await supabase.from("whatsapp_logs").insert({
        recipient_phone: "dummy",
        type: "Announcement",
        content: content,
        status: "Logged",
      });
    }
  }
  await supabase.from("announcements").insert({ title, content, channel, sent_at: new Date(), created_by: user.id });
  res.json({ message: "Announcement sent" });
});

// Leads (only for admin, not exposed on main page)
app.get("/api/admin/leads", async (req, res) => {
  if (!(await isAdmin(req))) return res.status(403).json({ error: "Admin only" });
  const { data } = await supabase.from("leads").select("*");
  res.json(data);
});

// Website settings (update images)
app.put("/api/admin/website", upload.fields([{ name: "heroImage" }, { name: "logo" }]), async (req, res) => {
  if (!(await isAdmin(req))) return res.status(403).json({ error: "Admin only" });
  const files = req.files;
  const updates = {};
  if (files?.heroImage) {
    const heroPath = `website/hero-${Date.now()}.jpg`;
    await supabase.storage.from("public-assets").upload(heroPath, files.heroImage[0].buffer);
    updates.hero_image_url = supabase.storage.from("public-assets").getPublicUrl(heroPath).data.publicUrl;
  }
  if (files?.logo) {
    const logoPath = `website/logo-${Date.now()}.png`;
    await supabase.storage.from("public-assets").upload(logoPath, files.logo[0].buffer);
    updates.logo_url = supabase.storage.from("public-assets").getPublicUrl(logoPath).data.publicUrl;
  }
  await supabase.from("site_config").upsert(updates);
  res.json(updates);
});

// Manual dues
app.post("/api/admin/dues", async (req, res) => {
  if (!(await isAdmin(req))) return res.status(403).json({ error: "Admin only" });
  const { tenantId, amount, reason, dueDate } = req.body;
  const newInvoice = {
    id: `inv-${Date.now()}`,
    tenant_id: tenantId,
    amount,
    due_date: dueDate,
    status: "Unpaid",
    bill_period: reason,
    generated_date: new Date().toISOString().split("T")[0],
  };
  await supabase.from("invoices").insert(newInvoice);
  res.json({ message: "Due added" });
});

// Tenant view dues
app.get("/api/tenant/dues", async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const { data } = await supabase.from("invoices").select("*").eq("tenant_id", user.id).neq("status", "Paid");
  res.json(data);
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});