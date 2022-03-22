FROM node:14.17.5-slim

COPY --from=api:1.0.0 /var/www/website-v1 /var/www/production

WORKDIR /parse-server

COPY . /parse-server/

RUN apt-get update \ 
&& npm install npm -g \ 
&& npm install \
&& npm run build \
&& useradd -ms /bin/bash docker \ 
&& chown -R docker /parse-server

USER docker

EXPOSE 1337

ENTRYPOINT ["npm", "start"]