const express = require("express");
const jwt = require("jsonwebtoken");

const router = express.Router();

// 📁 Liste des fichiers PDF
const FILES = {
  "frame-game": "https://sahmi.ma/downloads/frame-game.pdf",
  "7-layer-blueprint": "https://sahmi.ma/downloads/7-layer-blueprint.pdf",
  "objection-reframe-playbook": "https://sahmi.ma/downloads/objection-reframe-playbook.pdf",
  "elite-closer-identity-workbook": "https://sahmi.ma/downloads/elite-closer-identity-workbook.pdf",
  "closers-code": "https://sahmi.ma/downloads/closers-code.pdf"
};

// 🧪 Test route (garde pour debug)
router.get("/test", (req, res) => {
  res.json({ ok: true, message: "Download route works" });
});


// 🔐 Générer lien sécurisé (24h)
router.get("/generate", (req, res) => {
  const file = req.query.file;

  if (!FILES[file]) {
    return res.status(400).json({ error: "Fichier invalide" });
  }

  const token = jwt.sign(
    { file },
    process.env.DOWNLOAD_SECRET,
    { expiresIn: "24h" }
  );

  const link = `${process.env.BACKEND_URL}/download/verify?token=${token}`;

  res.json({ link });
});


// 🔓 Vérifier token + rediriger vers PDF
router.get("/verify", (req, res) => {
  const token = req.query.token;

  try {
    const decoded = jwt.verify(token, process.env.DOWNLOAD_SECRET);

    const fileUrl = FILES[decoded.file];

    if (!fileUrl) {
      return res.status(400).send("Fichier introuvable");
    }

    return res.redirect(fileUrl);

  } catch (err) {
    return res.status(401).send("Lien expiré ou invalide");
  }
});

module.exports = router;
