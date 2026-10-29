-- CreateTable
CREATE TABLE "stop_consumer_declarations" (
    "app_id" TEXT NOT NULL,
    "lane" TEXT NOT NULL,
    "declared_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stop_consumer_declarations_pkey" PRIMARY KEY ("app_id","lane")
);

-- AddForeignKey
ALTER TABLE "stop_consumer_declarations" ADD CONSTRAINT "stop_consumer_declarations_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
