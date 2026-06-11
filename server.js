import express from "express";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import multer from "multer";
import cors from "cors";
import dotenv from "dotenv";

// Force load .env only if it exists (optional)
dotenv.config();

console.log("=== Environment Variables Check ===");
console.log("SUPABASE_URL exists?", !!process.env.SUPABASE_URL);
console.log("SUPABASE_SERVICE_KEY exists?", !!process.env.SUPABASE_SERVICE_KEY);
console.log("RESEND_API_KEY exists?", !!process.env.RESEND_API_KEY);

// If variables are missing, throw a clear error
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error("❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());

// Supabase client
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);
// ... rest of your code remains unchanged