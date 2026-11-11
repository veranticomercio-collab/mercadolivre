import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: {
    "import.meta.env.VITE_SUPABASE_URL": JSON.stringify("https://jfnxzmwxetgrpicycaks.supabase.co"),
    "import.meta.env.VITE_SUPABASE_ANON_KEY": JSON.stringify("sb_publishable_Xij55rOkhSwCr-9kQx3uMQ_2IWW3gYR"),
  },
});
