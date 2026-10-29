-- Interest topic catalogue (requirements doc, Appendix B). Ids are assigned 1..17 in this order.
INSERT INTO "interest_topics" ("slug", "name", "sort_order") VALUES
  ('network-transformation', 'Network Transformation', 1),
  ('mobile-and-wireless', 'Mobile and Wireless', 2),
  ('digital-customer-experience', 'Digital Customer Experience', 3),
  ('innovation', 'Innovation', 4),
  ('automation-and-support-systems-oss-bss', 'Automation and Support Systems (OSS/BSS)', 5),
  ('iot-and-robotics', 'IoT and Robotics', 6),
  ('ai-automation-and-analytics', 'AI, Automation and Analytics', 7),
  ('digital-transformation', 'Digital Transformation', 8),
  ('testing-and-assurance', 'Testing and Assurance', 9),
  ('network-evolution-and-optimization', 'Network Evolution and Optimization', 10),
  ('5g-6g', '5G and 6G', 11),
  ('top-technology-trends', 'Top Technology Trends', 12),
  ('cloud-and-edge', 'Cloud and Edge', 13),
  ('quantum-computing', 'Quantum Computing', 14),
  ('security-and-assurance', 'Security and Assurance', 15),
  ('enterprise-voice-and-ai-cx', 'Enterprise Voice and AI CX', 16),
  ('operational-agility', 'Operational Agility', 17)
ON CONFLICT ("slug") DO NOTHING;
