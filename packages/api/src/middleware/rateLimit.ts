import rateLimit from 'express-rate-limit';

export const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      message: 'Too many agent registrations from this IP, please try again in an hour.',
    },
  },
});
