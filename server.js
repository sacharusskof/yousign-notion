require("dotenv").config();

const express = require("express");
const { Client } = require("@notionhq/client");

const app = express();
app.use(express.json());

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const NOTION_STUDIES_DATABASE_ID = process.env.NOTION_STUDIES_DATABASE_ID;

const ROLES = [
  {
    statusColumn: "Respo P&Q",
    dateColumn: "Date signature Respo P&Q",
    idColumn: "ID Respo P&Q",
  },
  {
    statusColumn: "Présidente",
    dateColumn: "Date signature Présidente",
    idColumn: "ID Présidente",
  },
  {
    statusColumn: "Client 1",
    dateColumn: "Date signature Client 1",
    idColumn: "ID Client 1",
  },
  {
    statusColumn: "Client 2",
    dateColumn: "Date signature Client 2",
    idColumn: "ID Client 2",
  },
];

async function getDataSourceId(databaseId) {
  const database = await notion.databases.retrieve({
    database_id: databaseId,
  });

  return database.data_sources[0].id;
}

async function getYousignDataSourceId() {
  return await getDataSourceId(NOTION_DATABASE_ID);
}

async function getStudiesDataSourceId() {
  return await getDataSourceId(NOTION_STUDIES_DATABASE_ID);
}

function textProperty(content) {
  return {
    rich_text: [
      {
        text: {
          content: content || "",
        },
      },
    ],
  };
}

function selectProperty(name) {
  return {
    select: {
      name,
    },
  };
}

function dateProperty(date) {
  return {
    date: {
      start: date,
    },
  };
}

function relationProperty(pageId) {
  return {
    relation: [
      {
        id: pageId,
      },
    ],
  };
}

function getEventName(event) {
  return event.event_name || event.event || event.type;
}

function getSignatureRequest(event) {
  return event.data?.signature_request || event.signature_request || {};
}

function getSigner(event) {
  return event.data?.signer || event.signer || {};
}

function getCurrentSignerId(event) {
  const signer = getSigner(event);

  return signer.id || event.data?.signer_id || event.signer_id || null;
}

function getSigners(event) {
  const signatureRequest = getSignatureRequest(event);

  return signatureRequest.signers || event.data?.signers || event.signers || [];
}

function getSignerStageValue(signer) {
  const value =
    signer.recipient_stage_index ??
    signer.recipientStageIndex ??
    signer.stage_index ??
    signer.order ??
    signer.position;

  if (value === undefined || value === null) {
    return null;
  }

  const numberValue = Number(value);

  if (Number.isNaN(numberValue)) {
    return null;
  }

  return numberValue;
}

function getOrderedSigners(event) {
  return getSigners(event)
    .map((signer, originalIndex) => ({
      signer,
      originalIndex,
      stageIndex: getSignerStageValue(signer) || originalIndex + 1,
    }))
    .sort((a, b) => {
      if (a.stageIndex !== b.stageIndex) {
        return a.stageIndex - b.stageIndex;
      }

      return a.originalIndex - b.originalIndex;
    })
    .map((item) => item.signer);
}

function getRequestId(event) {
  const eventName = getEventName(event);
  const signatureRequest = getSignatureRequest(event);
  const signer = getSigner(event);

  if (eventName && eventName.startsWith("signer.")) {
    return (
      signatureRequest.id ||
      event.data?.signature_request_id ||
      signer.signature_request_id ||
      signer.signature_request?.id ||
      null
    );
  }

  return signatureRequest.id || event.data?.id || null;
}

function getYousignTitle(event, yousignId) {
  const signatureRequest = getSignatureRequest(event);

  return (
    signatureRequest.name ||
    signatureRequest.title ||
    signatureRequest.external_id ||
    `Demande Yousign ${String(yousignId).slice(0, 8)}`
  );
}

function extractStudyReferenceFromTitle(title) {
  if (!title) return null;

  const match = title.trim().match(/^(.+_\d+(?:\.\d+)?_\d{4})-.+$/);

  if (!match) {
    return null;
  }

  return match[1].trim();
}

async function findStudyPageByReference(studyReference) {
  if (!studyReference) return null;

  const dataSourceId = await getStudiesDataSourceId();

  const response = await notion.dataSources.query({
    data_source_id: dataSourceId,
    filter: {
      property: "Référence",
      title: {
        equals: studyReference,
      },
    },
  });

  return response.results[0] || null;
}

async function findStudyForYousignEvent(event, yousignId) {
  const title = getYousignTitle(event, yousignId);
  const studyReference = extractStudyReferenceFromTitle(title);

  if (!studyReference) {
    return {
      studyReference: null,
      studyPage: null,
    };
  }

  const studyPage = await findStudyPageByReference(studyReference);

  return {
    studyReference,
    studyPage,
  };
}

function normalizeDate(value) {
  if (!value) return null;

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function getSignatureDate(event) {
  const signer = getSigner(event);
  const signatureRequest = getSignatureRequest(event);

  return (
    normalizeDate(signer.signed_at) ||
    normalizeDate(signatureRequest.completed_at) ||
    normalizeDate(signatureRequest.activated_at) ||
    normalizeDate(event.data?.created_at) ||
    normalizeDate(event.created_at) ||
    new Date().toISOString()
  );
}

function getTextFromPage(page, propertyName) {
  const property = page.properties?.[propertyName];

  if (!property) return "";

  if (property.type === "rich_text") {
    return property.rich_text.map((item) => item.plain_text).join("");
  }

  if (property.type === "title") {
    return property.title.map((item) => item.plain_text).join("");
  }

  if (property.type === "select") {
    return property.select?.name || "";
  }

  return "";
}

function buildInitialSignerProperties(event, status, withDates = false) {
  const orderedSigners = getOrderedSigners(event);
  const signerCount = orderedSigners.length || 3;
  const signedAt = getSignatureDate(event);

  const properties = {};

  ROLES.forEach((role, index) => {
    if (index < signerCount) {
      properties[role.statusColumn] = selectProperty(status);
      properties[role.idColumn] = textProperty(orderedSigners[index]?.id || "");

      if (withDates) {
        properties[role.dateColumn] = dateProperty(signedAt);
      }
    } else {
      properties[role.statusColumn] = selectProperty("Non concerné");
      properties[role.idColumn] = textProperty("");
    }
  });

  return properties;
}

function buildSignerIdUpdateProperties(event) {
  const orderedSigners = getOrderedSigners(event);
  const properties = {};

  ROLES.forEach((role, index) => {
    if (orderedSigners[index]?.id) {
      properties[role.idColumn] = textProperty(orderedSigners[index].id);
    }
  });

  return properties;
}

function findRoleIndexBySignerIdInPage(page, signerId) {
  if (!signerId) return -1;

  return ROLES.findIndex((role) => {
    const storedSignerId = getTextFromPage(page, role.idColumn);
    return storedSignerId === signerId;
  });
}

function findRoleIndexBySignerIdInEvent(event, signerId) {
  if (!signerId) return -1;

  const orderedSigners = getOrderedSigners(event);

  return orderedSigners.findIndex((signer) => signer.id === signerId);
}

async function findNotionPageByYousignId(yousignId) {
  const dataSourceId = await getYousignDataSourceId();

  const response = await notion.dataSources.query({
    data_source_id: dataSourceId,
    filter: {
      property: "Yousign ID",
      rich_text: {
        equals: yousignId,
      },
    },
  });

  return response.results[0];
}

async function createNotionPageFromYousign(
  event,
  status,
  studyPage,
  withSignatureDate = false
) {
  const dataSourceId = await getYousignDataSourceId();
  const yousignId = getRequestId(event);
  const title = getYousignTitle(event, yousignId);

  const properties = {
    "Nom": {
      title: [
        {
          text: {
            content: title,
          },
        },
      ],
    },
    "Yousign ID": textProperty(yousignId),
    "Statut signataire": selectProperty(status),
    "Études": relationProperty(studyPage.id),
    ...buildInitialSignerProperties(
      event,
      status === "Signé" ? "Signé" : "En attente",
      withSignatureDate
    ),
  };

  if (withSignatureDate) {
    properties["Date de signature"] = dateProperty(getSignatureDate(event));
  }

  return await notion.pages.create({
    parent: {
      data_source_id: dataSourceId,
    },
    properties,
  });
}

async function updateGlobalStatus(
  pageId,
  status,
  withSignatureDate = false,
  event = null
) {
  const properties = {
    "Statut signataire": selectProperty(status),
    ...buildSignerIdUpdateProperties(event || {}),
  };

  if (withSignatureDate) {
    properties["Date de signature"] = dateProperty(
      event ? getSignatureDate(event) : new Date().toISOString()
    );
  }

  await notion.pages.update({
    page_id: pageId,
    properties,
  });
}

async function updateSignerStatus(page, event) {
  const pageId = page.id;
  const signerId = getCurrentSignerId(event);
  const signedAt = getSignatureDate(event);

  let roleIndex = findRoleIndexBySignerIdInPage(page, signerId);

  if (roleIndex === -1) {
    roleIndex = findRoleIndexBySignerIdInEvent(event, signerId);
  }

  if (roleIndex < 0 || roleIndex >= ROLES.length) {
    console.log("Signataire non identifié clairement, aucune colonne modifiée.");
    return null;
  }

  const role = ROLES[roleIndex];

  await notion.pages.update({
    page_id: pageId,
    properties: {
      ...buildSignerIdUpdateProperties(event),
      [role.statusColumn]: selectProperty("Signé"),
      [role.dateColumn]: dateProperty(signedAt),
    },
  });

  return role.statusColumn;
}

async function createPageOnlyIfStudyExists(event, status, withSignatureDate = false) {
  const yousignId = getRequestId(event);
  const { studyReference, studyPage } = await findStudyForYousignEvent(
    event,
    yousignId
  );

  if (!studyReference || !studyPage) {
    console.log(
      `Demande ignorée : aucune étude trouvée pour "${getYousignTitle(
        event,
        yousignId
      )}".`
    );

    return null;
  }

  return await createNotionPageFromYousign(
    event,
    status,
    studyPage,
    withSignatureDate
  );
}

app.get("/", (req, res) => {
  res.send("Connecteur Yousign → Notion actif.");
});

app.get("/test-notion", async (req, res) => {
  try {
    const response = await notion.databases.retrieve({
      database_id: NOTION_DATABASE_ID,
    });

    res.json({
      success: true,
      database_title: response.title?.[0]?.plain_text || "Base sans titre",
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.post("/webhook/yousign", async (req, res) => {
  try {
    console.log("Webhook Yousign reçu :");
    console.log(JSON.stringify(req.body, null, 2));

    const event = req.body;
    const eventName = getEventName(event);
    const yousignId = getRequestId(event);

    if (!yousignId) {
      return res.status(400).json({
        success: false,
        error: "Aucun Yousign ID trouvé dans le webhook.",
      });
    }

    if (eventName === "signature_request.activated") {
      const { studyReference, studyPage } = await findStudyForYousignEvent(
        event,
        yousignId
      );

      if (!studyReference || !studyPage) {
        return res.status(200).json({
          success: true,
          ignored: true,
          message:
            "Demande ignorée : le nom ne correspond à aucune étude existante.",
          yousignId,
        });
      }

      const existingPage = await findNotionPageByYousignId(yousignId);

      if (existingPage) {
        await notion.pages.update({
          page_id: existingPage.id,
          properties: {
            "Statut signataire": selectProperty("En cours"),
            "Études": relationProperty(studyPage.id),
            ...buildSignerIdUpdateProperties(event),
          },
        });

        return res.status(200).json({
          success: true,
          message: "Ligne Notion déjà existante, étude et IDs enregistrés",
          yousignId,
        });
      }

      await createNotionPageFromYousign(event, "En cours", studyPage, false);

      return res.status(200).json({
        success: true,
        message: "Ligne Notion créée avec relation Études",
        yousignId,
      });
    }

    if (eventName === "signer.done") {
      let existingPage = await findNotionPageByYousignId(yousignId);

      if (!existingPage) {
        existingPage = await createPageOnlyIfStudyExists(
          event,
          "En cours",
          false
        );
      }

      if (!existingPage) {
        return res.status(200).json({
          success: true,
          ignored: true,
          message: "Demande ignorée : aucune étude correspondante.",
          yousignId,
        });
      }

      const updatedRole = await updateSignerStatus(existingPage, event);

      if (!updatedRole) {
        return res.status(200).json({
          success: true,
          message: "Signataire non identifié, aucune colonne modifiée",
          yousignId,
        });
      }

      return res.status(200).json({
        success: true,
        message: `${updatedRole} mis à jour en Signé`,
        yousignId,
      });
    }

    if (eventName === "signature_request.done") {
      let existingPage = await findNotionPageByYousignId(yousignId);

      if (!existingPage) {
        existingPage = await createPageOnlyIfStudyExists(event, "Signé", true);
      }

      if (!existingPage) {
        return res.status(200).json({
          success: true,
          ignored: true,
          message: "Demande ignorée : aucune étude correspondante.",
          yousignId,
        });
      }

      await updateGlobalStatus(existingPage.id, "Signé", true, event);

      return res.status(200).json({
        success: true,
        message: "Statut global Notion mis à jour en Signé",
        yousignId,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Événement ignoré",
      eventName,
    });
  } catch (error) {
    console.error("Erreur webhook :", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Serveur lancé sur le port ${process.env.PORT || 3000}`);
});