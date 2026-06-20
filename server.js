require("dotenv").config();

const express = require("express");
const { Client } = require("@notionhq/client");

const app = express();
app.use(express.json());

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

async function getDataSourceId() {
  const database = await notion.databases.retrieve({
    database_id: NOTION_DATABASE_ID,
  });

  return database.data_sources[0].id;
}

function getEventName(event) {
  return event.event_name || event.event || event.type;
}

function getSignatureRequest(event) {
  return event.data?.signature_request || event.data || {};
}

function getYousignId(event) {
  const signatureRequest = getSignatureRequest(event);
  return signatureRequest.id || event.data?.id;
}

function getYousignTitle(event, yousignId) {
  const signatureRequest = getSignatureRequest(event);

  return (
    signatureRequest.name ||
    signatureRequest.title ||
    signatureRequest.external_id ||
    `Demande Yousign ${yousignId.slice(0, 8)}`
  );
}

function getFirstSignerEmail(event) {
  const signatureRequest = getSignatureRequest(event);

  const signers =
    signatureRequest.signers ||
    event.data?.signers ||
    event.data?.signature_request?.signers ||
    [];

  const firstSigner = signers[0];

  return (
    firstSigner?.email ||
    firstSigner?.info?.email ||
    firstSigner?.contact?.email ||
    null
  );
}

async function findNotionPageByYousignId(yousignId) {
  const dataSourceId = await getDataSourceId();

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

async function createNotionPageFromYousign(event, status, withSignatureDate = false) {
  const dataSourceId = await getDataSourceId();
  const yousignId = getYousignId(event);
  const title = getYousignTitle(event, yousignId);
  const email = getFirstSignerEmail(event);

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
    "Yousign ID": {
      rich_text: [
        {
          text: {
            content: yousignId,
          },
        },
      ],
    },
    "Statut signataire": {
      select: {
        name: status,
      },
    },
  };

  if (email) {
    properties["E-mail"] = {
      email: email,
    };
  }

  if (withSignatureDate) {
    properties["Date de signature"] = {
      date: {
        start: new Date().toISOString(),
      },
    };
  }

  return await notion.pages.create({
    parent: {
      data_source_id: dataSourceId,
    },
    properties,
  });
}

async function updateNotionPage(pageId, status, withSignatureDate = false) {
  const properties = {
    "Statut signataire": {
      select: {
        name: status,
      },
    },
  };

  if (withSignatureDate) {
    properties["Date de signature"] = {
      date: {
        start: new Date().toISOString(),
      },
    };
  }

  await notion.pages.update({
    page_id: pageId,
    properties,
  });
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
    const yousignId = getYousignId(event);

    if (!yousignId) {
      return res.status(400).json({
        success: false,
        error: "Aucun Yousign ID trouvé dans le webhook.",
      });
    }

    if (eventName === "signature_request.activated") {
      const existingPage = await findNotionPageByYousignId(yousignId);

      if (existingPage) {
        await updateNotionPage(existingPage.id, "En cours", false);

        return res.status(200).json({
          success: true,
          message: "Ligne Notion déjà existante, statut mis à jour en En cours",
          yousignId,
        });
      }

      await createNotionPageFromYousign(event, "En cours", false);

      return res.status(200).json({
        success: true,
        message: "Ligne Notion créée",
        yousignId,
      });
    }

    if (eventName === "signature_request.done") {
      const existingPage = await findNotionPageByYousignId(yousignId);

      if (existingPage) {
        await updateNotionPage(existingPage.id, "Signé", true);

        return res.status(200).json({
          success: true,
          message: "Notion mis à jour en Signé",
          yousignId,
        });
      }

      await createNotionPageFromYousign(event, "Signé", true);

      return res.status(200).json({
        success: true,
        message: "Ligne Notion créée directement en Signé",
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