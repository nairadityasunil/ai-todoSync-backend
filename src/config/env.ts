import dotenv from "dotenv";

dotenv.config();

export interface EnvConfig {
  PORT: number;
  MONGODB_URI: string;
  JWT_SECRET: string;
  JWT_EXPIRES_IN: string;
  REFRESH_TOKEN_EXPIRES_IN: string;
  MAX_COMPANION_DEVICES: number;
  ALLOWED_ORIGINS: string[];
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REDIRECT_URI: string;
  FRONTEND_BASE_URL: string;
  GPT_OAUTH_REDIRECT_URI: string;
  BACKEND_URL: string;
  ENCRYPTION_KEY: string;
  AI_PROVIDER_BASE_URL?: string;
  AI_PROVIDER_API_KEY?: string;
  AI_PROVIDER_MODEL: string;
  SMTP_HOST?: string;
  SMTP_PORT?: number;
  SMTP_SECURE?: boolean;
  SMTP_SERVICE?: string;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  SMTP_FROM?: string;
  BREVO_API_KEY?: string;
  EMAIL_FROM?: string;
  REDIS_URL: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL: string;
  CLOUDINARY_CLOUD_NAME?: string;
  CLOUDINARY_API_KEY?: string;
  CLOUDINARY_API_SECRET?: string;
}

const {
  PORT = "4000",
  MONGODB_URI,
  JWT_SECRET,
  JWT_EXPIRES_IN,
  REFRESH_TOKEN_EXPIRES_IN = "30d",
  MAX_COMPANION_DEVICES = "5",
  ALLOWED_ORIGINS = "",
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI,
  FRONTEND_BASE_URL,
  GPT_OAUTH_REDIRECT_URI,
  ENCRYPTION_KEY,
  BACKEND_URL,
  AI_PROVIDER_BASE_URL,
  AI_PROVIDER_API_KEY,
  AI_PROVIDER_MODEL = "gpt-4.1-mini",
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE,
  SMTP_SERVICE,
  SMTP_USER,
  SMTP_PASS,
  SMTP_FROM,
  BREVO_API_KEY,
  EMAIL_FROM,
  REDIS_URL = "redis://127.0.0.1:6379",
  GEMINI_API_KEY,
  GEMINI_MODEL = "gemini-2.0-flash",
  CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET,
} = process.env;

if (!MONGODB_URI || !JWT_SECRET || !JWT_EXPIRES_IN) {
  throw new Error("Missing required environment variables for backend startup");
}

if (
  !GOOGLE_CLIENT_ID ||
  !GOOGLE_CLIENT_SECRET ||
  !GOOGLE_REDIRECT_URI ||
  !FRONTEND_BASE_URL ||
  !GPT_OAUTH_REDIRECT_URI ||
  !BACKEND_URL ||
  !ENCRYPTION_KEY
) {
  throw new Error(
    "Missing required Google OAuth environment variables for backend startup",
  );
}

const env: EnvConfig = {
  PORT: Number(PORT),
  MONGODB_URI,
  JWT_SECRET,
  JWT_EXPIRES_IN,
  REFRESH_TOKEN_EXPIRES_IN,
  MAX_COMPANION_DEVICES: Number(MAX_COMPANION_DEVICES),
  ALLOWED_ORIGINS: ALLOWED_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  GOOGLE_CLIENT_ID: GOOGLE_CLIENT_ID.trim(),
  GOOGLE_CLIENT_SECRET: GOOGLE_CLIENT_SECRET.trim(),
  GOOGLE_REDIRECT_URI: GOOGLE_REDIRECT_URI.trim(),
  FRONTEND_BASE_URL: FRONTEND_BASE_URL.trim(),
  GPT_OAUTH_REDIRECT_URI: GPT_OAUTH_REDIRECT_URI.trim(),
  BACKEND_URL: BACKEND_URL.trim(),
  ENCRYPTION_KEY: ENCRYPTION_KEY.trim(),
  AI_PROVIDER_BASE_URL: AI_PROVIDER_BASE_URL?.trim() || undefined,
  AI_PROVIDER_API_KEY: AI_PROVIDER_API_KEY?.trim() || undefined,
  AI_PROVIDER_MODEL: AI_PROVIDER_MODEL.trim(),
  SMTP_HOST: SMTP_HOST?.trim() || undefined,
  SMTP_PORT: SMTP_PORT ? Number(SMTP_PORT) : undefined,
  SMTP_SECURE: SMTP_SECURE === "true",
  SMTP_SERVICE: SMTP_SERVICE?.trim() || undefined,
  SMTP_USER: SMTP_USER?.trim() || undefined,
  SMTP_PASS: SMTP_PASS?.trim() || undefined,
  SMTP_FROM: SMTP_FROM?.trim() || undefined,
  BREVO_API_KEY: BREVO_API_KEY?.trim() || undefined,
  EMAIL_FROM: EMAIL_FROM?.trim() || undefined,
  REDIS_URL: REDIS_URL.trim(),
  GEMINI_API_KEY: GEMINI_API_KEY?.trim() || undefined,
  GEMINI_MODEL: GEMINI_MODEL.trim(),
  CLOUDINARY_CLOUD_NAME: CLOUDINARY_CLOUD_NAME?.trim() || undefined,
  CLOUDINARY_API_KEY: CLOUDINARY_API_KEY?.trim() || undefined,
  CLOUDINARY_API_SECRET: CLOUDINARY_API_SECRET?.trim() || undefined,
};

export default env;
