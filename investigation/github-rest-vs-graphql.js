const axios = require("axios");

const httpError = (error) => {
  console.error(error);
  throw new Error(error);
};

const callRestData = async (token, page) => {
  page = page || 1;
  return axios("https://api.github.com/user/repos?affiliation=owner&per_page=100&page=" + page, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + token
    }
  })
    .then(response => response.data.map((repo) => repo.full_name))
    .catch(httpError);
}

const getRestData = async (token) => {
  let more = true;
  let data = [];
  let page = 1;
  while(more === true) {
    const result = await callRestData(token, page);
    data = data.concat(result);
    more = result.length === 100;
    page++;
  }
  return data;
}

const getQuery = (after) => `query {
  viewer {
    repositories(affiliations: OWNER, first:100 ${after ? `, after:"${after}"` : ""}) {
      edges {
        cursor,
        node {
          nameWithOwner
        }
      }
    }
  }
}`;

const callGraphql = (token, cursor) =>
  axios("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + token
    },
    data: JSON.stringify({
      variables: {},
      query: getQuery(cursor)
    })
  })
    .then(response => ({
      repos: response.data.data.viewer.repositories.edges.map(x => x.node.nameWithOwner),
      after: response.data.data.viewer.repositories.edges.pop().cursor
    }))
    .catch(httpError);

const getGraphqlData = async (token) => {
  let more = true;
  let data = [];
  let lastCursor;
  while(more === true) {
    const result = await callGraphql(token, lastCursor);
    data = data.concat(result.repos);
    more = result.repos.length === 100;
    lastCursor = result.after;
  }
  return data;
}

const getDifference = async (token) => {
  const data = await Promise.all([getRestData(token), getGraphqlData(token)]);
  console.log(`rest repos (${data[0].length}): ${data[0]}`);
  console.log(`graphql repos (${data[1].length}): ${data[1]}`);
};

getDifference(process.env.GITHUB_TOKEN);
