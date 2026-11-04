CREATE OR REPLACE VIEW effective_plan AS
SELECT 
    u.id AS user_id,
    CASE 
        WHEN s.status = 'ACTIVE' AND s.current_period_end > NOW() THEN p.name
        WHEN r.status = 'ACTIVE' AND r.expires_at > NOW() THEN 'premium'
        ELSE 'free'
    END AS plan
FROM users u
LEFT JOIN subscriptions s ON s.user_id = u.id AND s.status = 'ACTIVE' AND s.current_period_end > NOW()
LEFT JOIN plans p ON p.id = s.plan_id
LEFT JOIN rentals r ON r.user_id = u.id AND r.status = 'ACTIVE' AND r.expires_at > NOW()
GROUP BY u.id, s.status, s.current_period_end, p.name, r.status, r.expires_at;