FROM node:18-bullseye as intermediate
ARG GIT_TOKEN
ARG BRANCH=dev
RUN apt-get update && apt-get install -y git

RUN git config --global credential.helper 'cache --timeout=3600'
RUN export GIT_ASKPASS=${GIT_TOKEN}

RUN git clone -b ${BRANCH} --recurse-submodules https://${GIT_TOKEN}:x-oauth-basic@github.com/insidemaps-org/website-v1.git

FROM node:18-bullseye

COPY --from=intermediate /website-v1 /var/www/production

WORKDIR /var/www/production

RUN apt-get update && apt-get install -y default-jdk
RUN npm install -g npm@latest

RUN echo '{"parseServerURLForNode": {"URL": "https://parse-dev.insidemaps.com/parse"}}' > ./config.json
RUN npm i


RUN npm run build-ts
RUN npm run build -ws

RUN mkdir /var/log/insideMaps
RUN chmod g+w,a+w /var/log/insideMaps
RUN mkdir /var/tmp/insideMaps
RUN mkdir /var/tmp/insideMaps/files
RUN chmod g+w,a+w /var/tmp/insideMaps/files


RUN mkdir -p /parse-server
COPY ./ /parse-server/

RUN mkdir -p /parse-server/config
VOLUME /parse-server/config

RUN mkdir -p /parse-server/cloud
VOLUME /parse-server/cloud

WORKDIR /parse-server

RUN npm install && npm run build

ENV PORT=1337

EXPOSE $PORT

ENTRYPOINT ["npm", "start", "--"]
