import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/analyze": ["./public/data/sonart_erp_cok_donemli_2.csv"],
  },
};

export default nextConfig;
