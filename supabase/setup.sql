-- Run this entire file in your Supabase SQL editor (supabase.com → your project → SQL Editor)

-- 1. Create the profiles table (linked to Supabase Auth users)
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  credits_remaining INTEGER NOT NULL DEFAULT 3,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable Row Level Security so users can only read their own profile
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own profile"
  ON public.profiles FOR SELECT
  USING (auth.uid() = id);

-- Auto-create a profile row when a new user signs up
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, NEW.email)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 2. Atomic credit decrement — avoids race conditions from two tabs running at once
CREATE OR REPLACE FUNCTION public.decrement_credit(p_user_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  remaining INTEGER;
BEGIN
  UPDATE public.profiles
     SET credits_remaining = credits_remaining - 1
   WHERE id = p_user_id
     AND credits_remaining > 0
  RETURNING credits_remaining INTO remaining;

  IF remaining IS NULL THEN
    RAISE EXCEPTION 'INSUFFICIENT_CREDITS';
  END IF;

  RETURN remaining;
END;
$$;

-- 3. Private storage bucket for marked-up PDFs
INSERT INTO storage.buckets (id, name, public)
VALUES ('markups', 'markups', false)
ON CONFLICT (id) DO NOTHING;

-- 4. RLS: users can only read their own output files (the edge function uses the
--    service role key for uploads/signing, so no public write policy is needed)
CREATE POLICY "Users can read their own markup files"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'markups' AND (storage.foldername(name))[1] = auth.uid()::text);
