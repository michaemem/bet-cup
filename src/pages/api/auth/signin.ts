import type { APIRoute } from "astro";
import { z } from "zod";
import { createClient } from "@/lib/supabase";
import { synthEmail } from "@/lib/username";

export const prerender = false;

const SigninSchema = z.object({
  login: z.string().trim().min(1),
  password: z.string().min(6),
});

export const POST: APIRoute = async (context) => {
  const form = await context.request.formData();
  const parsed = SigninSchema.safeParse({
    login: form.get("login"),
    password: form.get("password"),
  });

  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Invalid credentials";
    return context.redirect(`/auth/signin?error=${encodeURIComponent(message)}`);
  }

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return context.redirect(`/auth/signin?error=${encodeURIComponent("Supabase is not configured")}`);
  }

  // Participants log in with a bare username -> synthetic email; an input
  // containing "@" is treated as a literal email (passthrough for the seeded
  // admin, whose ADMIN_EMAIL may not end in @betcup.local).
  const email = parsed.data.login.includes("@") ? parsed.data.login : synthEmail(parsed.data.login);

  const { error } = await supabase.auth.signInWithPassword({ email, password: parsed.data.password });
  if (error) {
    return context.redirect(`/auth/signin?error=${encodeURIComponent(error.message)}`);
  }

  return context.redirect("/dashboard");
};
