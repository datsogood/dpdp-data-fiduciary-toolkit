const express = require("express");

const persistPIIwithconsent = require("../services/persistPIIwithconsent");
const withdrawConsent = require("../services/withdrawConsent");
const { listRights, exerciseRight } = require("../services/dataPrincipalRights");
const { complaintToTheBoard, escalateToBoard } = require("../services/complaintToTheBoard");
const consentManagerRequest = require("../services/consentManagerRequest");
const { renderRightsPage, renderGrievanceForm, renderConsentManagerForm } = require("./forms");

function createRouter() {
  const router = express.Router();
  router.use(express.json());
  router.use(express.urlencoded({ extended: true }));

  // 1. POST /consent — persistPIIwithconsent
  router.post("/consent", async (req, res) => {
    try {
      const result = await persistPIIwithconsent(req.body);
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // 2. PUT /consent/withdraw — withdrawConsent
  router.put("/consent/withdraw", async (req, res) => {
    try {
      const result = await withdrawConsent(req.body);
      res.status(200).json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // 3. Data Principal Rights page + request submission
  router.get("/rights", (req, res) => {
    if (req.accepts("html")) return res.type("html").send(renderRightsPage());
    res.json(listRights());
  });
  router.post("/rights/exercise", async (req, res) => {
    try {
      const result = await exerciseRight(req.body);
      if (req.accepts("html")) {
        return res.type("html").send(`<p>Request received. Reference: <b>${result.refId}</b></p>`);
      }
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // 4. complaintToTheBoard — opens a grievance form addressed to the DPO
  router.get("/grievance/new", (req, res) => res.type("html").send(renderGrievanceForm()));
  router.post("/grievance", async (req, res) => {
    try {
      const result = await complaintToTheBoard(req.body);
      if (req.accepts("html")) {
        return res.type("html").send(`<p>Sent to ${result.addressedTo}. Reference: <b>${result.refId}</b>. SLA: ${result.slaDueAt}</p>`);
      }
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
  router.post("/grievance/:refId/escalate", async (req, res) => {
    try {
      const result = await escalateToBoard({ refId: req.params.refId });
      res.status(200).json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // 5. consentManagerRequest — opens a form to raise a request to a Consent Manager
  router.get("/consent-manager/new", (req, res) => res.type("html").send(renderConsentManagerForm()));
  router.post("/consent-manager", async (req, res) => {
    try {
      const result = await consentManagerRequest(req.body);
      if (req.accepts("html")) {
        return res.type("html").send(`<p>Request received. Reference: <b>${result.refId}</b></p>`);
      }
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createRouter;
