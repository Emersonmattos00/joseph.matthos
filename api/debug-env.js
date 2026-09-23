module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    ok: true,
    env: {
      RENTAL_PRICE_24H:  process.env.RENTAL_PRICE_24H  || null,
      RENTAL_PRICE_48H:  process.env.RENTAL_PRICE_48H  || null,
      RENTAL_PRICE_3D:   process.env.RENTAL_PRICE_3D   || null,
      RENTAL_PRICE_5D:   process.env.RENTAL_PRICE_5D   || null,
      RENTAL_PRICE_10D:  process.env.RENTAL_PRICE_10D  || null,
      RENTAL_PRICE_15D:  process.env.RENTAL_PRICE_15D  || null,
      MP_PREMIUM_MONTHLY_PRICE: process.env.MP_PREMIUM_MONTHLY_PRICE || null,
      MP_PREMIUM_ANNUAL_PRICE:  process.env.MP_PREMIUM_ANNUAL_PRICE  || null,
      SUPABASE_URL: process.env.SUPABASE_URL || null,
      VERCEL_ENV: process.env.VERCEL_ENV || null
    }
  });
};
