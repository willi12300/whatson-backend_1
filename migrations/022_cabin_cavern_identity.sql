-- Cabin (Wood Street) and Cavern (Mathew Street) are different businesses.
-- Preserve the original Cabin ID/location and all saved-plan references.
-- Only relocate the positively identified Cavern Google source, with a private
-- before-snapshot; never turn the Cabin record into a renamed Cavern record.
CREATE TABLE IF NOT EXISTS venue_identity_repair_archive (
 repair_key TEXT PRIMARY KEY, original_venue JSONB NOT NULL,
 original_source JSONB NOT NULL, corrected_venue_id INTEGER,
 repaired_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
DO $$
DECLARE original venues%ROWTYPE; source venue_sources%ROWTYPE; target_id INTEGER;
 p_lat DOUBLE PRECISION; p_lng DOUBLE PRECISION; p_name TEXT;
BEGIN
 IF EXISTS(SELECT 1 FROM venue_identity_repair_archive WHERE repair_key='cabin-cavern-20261022') THEN RETURN; END IF;
 SELECT * INTO original FROM venues WHERE id=7091 FOR UPDATE;
 IF NOT FOUND OR original.name<>'The Cabin Club' OR abs(original.lat-53.4017584)>0.0005 OR abs(original.lng+2.9761604)>0.0005 THEN RETURN; END IF;
 SELECT * INTO source FROM venue_sources WHERE venue_id=7091 AND provider='google' AND provider_id='ChIJydGcNC4he0gROPWMqQwzUDs' FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 p_name:=lower(COALESCE(source.raw->'displayName'->>'text',source.raw->>'name',''));
 IF p_name NOT IN ('the cavern club','cavern club') THEN RETURN; END IF;
 p_lat:=(source.raw->'location'->>'latitude')::double precision;
 p_lng:=(source.raw->'location'->>'longitude')::double precision;
 -- Mathew Street geofence, consistent with the venue's published address.
 IF p_lat IS NULL OR p_lng IS NULL OR abs(p_lat-53.4062)>0.001 OR abs(p_lng+2.988)>0.001 THEN RETURN; END IF;
 SELECT id INTO target_id FROM venues WHERE lower(name) IN ('the cavern club','cavern club') AND abs(lat-p_lat)<0.0003 AND abs(lng-p_lng)<0.0003 ORDER BY claimed DESC,id LIMIT 1 FOR UPDATE;
 IF target_id IS NULL THEN
  INSERT INTO venues(name,normalised_name,category_slug,lat,lng,address,postcode,city,country,website,google_place_id)
  VALUES('The Cavern Club','the cavern club','music_venue',p_lat,p_lng,'10 Mathew Street, Liverpool L2 6RE','L2 6RE','Liverpool','GB','https://www.cavernclub.com/',source.provider_id) RETURNING id INTO target_id;
 END IF;
 INSERT INTO venue_identity_repair_archive(repair_key,original_venue,original_source,corrected_venue_id)
 VALUES('cabin-cavern-20261022',to_jsonb(original),to_jsonb(source),target_id);
 UPDATE venue_sources SET venue_id=target_id WHERE id=source.id;
 -- The Cabin stays quarantined by the reviewed policy; discard only the bad
 -- direct Google association so future sync cannot overwrite it as the Cavern.
 UPDATE venues SET google_place_id=NULL,google_maps_url=NULL WHERE id=original.id;
END $$;
