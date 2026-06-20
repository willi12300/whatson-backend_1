INSERT INTO categories (slug, label, icon, color) VALUES
  ('park', 'Park', '🌳', '#2ED573'),
  ('garden', 'Garden', '🌿', '#2ED573'),
  ('attraction', 'Attraction', '📸', '#70A1FF'),
  ('museum', 'Museum', '🏛️', '#FFA502'),
  ('gallery', 'Gallery', '🖼️', '#A29BFE'),
  ('historic', 'Historic', '🏰', '#FFB142'),
  ('landmark', 'Landmark', '📍', '#70A1FF'),
  ('cinema', 'Cinema', '🎬', '#FF5E57'),
  ('theatre', 'Theatre', '🎭', '#E84393'),
  ('breakfast', 'Breakfast', '🍳', '#FFA502')
ON CONFLICT (slug) DO NOTHING;
