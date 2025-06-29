# Backend - Sistema de Fotos de Ballet

API backend para o sistema de fotos de ballet, construída com Node.js, Express e MongoDB.

## 🚀 Funcionalidades

- Autenticação com Google OAuth
- Gerenciamento de usuários
- Upload e gerenciamento de fotos
- Integração com MinIO/S3
- Cache com Redis
- API RESTful

## 📋 Pré-requisitos

- Node.js 18+
- MongoDB
- Redis
- MinIO ou AWS S3

## 🛠️ Instalação

1. Clone o repositório
2. Instale as dependências:
   ```bash
   npm install
   ```

3. Configure as variáveis de ambiente:
   ```bash
   cp config.env.example .env
   ```

4. Configure as seguintes variáveis no arquivo `.env`:
   ```
   NODE_ENV=development
   PORT=3001
   MINIO_ENDPOINT=your-minio-endpoint
   MINIO_ACCESS_KEY=your-access-key
   MINIO_SECRET_KEY=your-secret-key
   MINIO_BUCKET=your-bucket-name
   MONGODB_URI=your-mongodb-uri
   JWT_SECRET=your-jwt-secret
   GOOGLE_CLIENT_ID=your-google-client-id
   REDIS_URL=your-redis-url
   ```

## 🏃‍♂️ Executando

### Desenvolvimento
```bash
npm run dev
```

### Produção
```bash
npm start
```

## 🐳 Docker

### Build
```bash
docker build -t backend-fotos .
```

### Executar
```bash
docker run -p 3001:3001 backend-fotos
```

## 📚 API Endpoints

- `GET /api/eventos` - Lista eventos
- `GET /api/eventos/:evento/coreografias` - Lista coreografias de um evento
- `GET /api/eventos/:evento/coreografias/:coreografia/fotos` - Lista fotos de uma coreografia
- `POST /api/auth/google` - Login com Google
- `POST /api/auth/register` - Registro de usuário
- `POST /api/auth/login` - Login tradicional

## 🔧 Tecnologias

- Node.js
- Express
- MongoDB (Mongoose)
- Redis
- AWS SDK (MinIO/S3)
- Google Auth Library
- JWT
- bcryptjs 