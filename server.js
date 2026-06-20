require("dotenv").config();

const express = require("express");
const { Client } = require("@notionhq/client");

const app = express();
app.use(express.json());

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

async function findNotionPageByYousignId(yousignId) {
  const database = await notion.databases.retrieve({
    database_id: NOTION_DATABASE_ID,
  });

  const dataSourceId = database.data_sources[0].id;

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

async function updateNotionPage(pageId) {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      "Statut signataire": {
        select: {
          name: "Signé",
        },
      },
      "Date de signature": {
        date: {
          start: new Date().toISOString(),
        },
      },
    },
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

    if (event.event_name !== "signature_request.done") {
      return res.status(200).json({
        success: true,
        message: "Événement ignoré",
      });
    }

    const yousignId = event.data?.signature_request?.id || event.data?.id;

    if (!yousignId) {
      return res.status(400).json({
        success: false,
        error: "Aucun Yousign ID trouvé dans le webhook.",
      });
    }

    const page = await findNotionPageByYousignId(yousignId);

    if (!page) {
      return res.status(404).json({
        success: false,
        error: `Aucune ligne Notion trouvée avec Yousign ID = ${yousignId}`,
      });
    }

    await updateNotionPage(page.id);

    return res.status(200).json({
      success: true,
      message: "Notion mis à jour",
      yousignId,
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